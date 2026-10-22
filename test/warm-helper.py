import importlib.util,unittest,os,socket,struct,json,tempfile,threading,time,http.client
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',Path(__file__).parents[1]/'src/hooks/recall-warm.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class FakeTransport:
 def __init__(self):self.calls=[];self.closed=False
 def request(self,*args):self.calls.append(args);return {'v':1,'status':200,'headers':{},'body':json.dumps({'results':[{'id':str(len(self.calls))}]})}
 def close(self):self.closed=True
class Tests(unittest.TestCase):
 def test_actual_same_uid_socket_and_idle_exit(self):
  with tempfile.TemporaryDirectory() as d:
   os.chmod(d,0o700);p=Path(d)/'r.sock';t=FakeTransport();thread=threading.Thread(target=h.serve,args=(p,.15,t));thread.start()
   try:
    for _ in range(100):
     if p.exists():break
     time.sleep(.005)
    self.assertEqual(p.stat().st_mode&0o777,0o600)
    for _ in range(2):
     with socket.socket(socket.AF_UNIX) as s:
      s.connect(str(p));s.sendall((json.dumps({'v':1,'url':'https://api.supermemory.ai/ns/test/search','method':'POST','headers':{'authorization':'fixture'},'body':'{"query":"fresh"}'})+'\n').encode())
      f=s.makefile('rb');self.assertTrue(json.loads(f.readline())['ready']);self.assertEqual(json.loads(f.readline())['status'],200);f.close()
    self.assertEqual(len(t.calls),2)
   finally:thread.join(2)
   self.assertFalse(thread.is_alive());self.assertFalse(p.exists());self.assertTrue(t.closed)
   self.assertEqual([x.name for x in Path(d).iterdir()],['lock'])
   self.assertEqual((Path(d)/'lock').read_bytes(),b'')
 def test_foreign_uid_rejected_before_read(self):
  class Peer:
   def getsockopt(self,*a):return struct.pack('3i',1,os.getuid()+1,1)
   def recv(self,*a):raise AssertionError('read from foreign UID')
   def settimeout(self,*a):raise AssertionError('accepted foreign UID')
   def close(self):self.closed=True
  peer=Peer();self.assertFalse(h.same_uid(peer));h.handle(peer,FakeTransport());self.assertTrue(peer.closed)
 def test_routes_cannot_write_or_forward_to_other_host(self):
  for u in ['https://api.supermemory.ai/ns/test/add','https://api.supermemory.ai/ns/test/forget','https://evil.test/ns/test/search','http://api.supermemory.ai/ns/test/search','https://api.supermemory.ai/ns/test/search?evil=1']:
   with self.assertRaises(ValueError):h.validate({'v':1,'method':'POST','url':u,'headers':{},'body':'{}'})
 def test_insecure_parent_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   os.chmod(d,0o755)
   with self.assertRaises(ValueError):h.serve(Path(d)/'r.sock',.1,FakeTransport())
 def test_keepalive_reuses_connection_but_sends_every_search(self):
  connections=[]
  class Response:
   status=200;will_close=False;length=0
   def read(self,n):return b'{"results":[]}'
   def getheader(self,*a):return 'application/json'
  class Connection:
   sock=None
   def __init__(self,*a,**k):self.calls=[];connections.append(self)
   def connect(self):pass
   def request(self,*a,**k):self.calls.append((a,k))
   def getresponse(self):return Response()
   def close(self):pass
  with patch.object(h.http.client,'HTTPSConnection',Connection):
   transport=h.Transport()
   for _ in range(2):transport.request('/ns/test/search',{'Authorization':'fixture'},b'{"query":"fresh"}')
   self.assertEqual(len(connections),1);self.assertEqual(len(connections[0].calls),2);transport.close()
class Upstream:
 """Plain HTTP/1.1 server on localhost standing in for the provider; script(sock, connection_no, request_no) decides each reply."""
 def __init__(self,script):
  self.script=script;self.connections=0;self.requests=0;self.socks=[]
  self.server=socket.socket();self.server.bind(('127.0.0.1',0));self.server.listen(16);self.port=self.server.getsockname()[1]
  threading.Thread(target=self.accept,daemon=True).start()
 def accept(self):
  while True:
   try:sock,_=self.server.accept()
   except OSError:return
   self.connections+=1;self.socks.append(sock);threading.Thread(target=self.talk,args=(sock,self.connections),daemon=True).start()
 def talk(self,sock,number):
  request=0
  try:
   while True:
    data=b''
    while b'\r\n\r\n' not in data:
     chunk=sock.recv(65536)
     if not chunk:return
     data+=chunk
    head,_,rest=data.partition(b'\r\n\r\n')
    need=int([l.split(b':')[1] for l in head.split(b'\r\n') if l.lower().startswith(b'content-length')][0])
    while len(rest)<need:rest+=sock.recv(65536)
    self.requests+=1
    if self.script(sock,number,request)=='close':return
    request+=1
  except OSError:pass
  finally:sock.close()
 def close(self):
  self.server.close()
  for s in self.socks:
   try:s.close()
   except OSError:pass
def reply(sock,body=b'{"results":[{"id":"fresh"}]}'):
 sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
def via(upstream):
 return patch.object(h.http.client,'HTTPSConnection',lambda host,timeout=None,context=None:http.client.HTTPConnection('127.0.0.1',upstream.port,timeout=timeout))
def ask(path,budget_ms=None):
 """Send one search to the helper; return [(seconds, frame)] until it hangs up."""
 request={'v':1,'url':'https://api.supermemory.ai/ns/test/search','method':'POST','headers':{'authorization':'fixture'},'body':'{"query":"fresh"}'}
 if budget_ms is not None:request['budget_ms']=budget_ms
 frames=[];start=time.monotonic()
 with socket.socket(socket.AF_UNIX) as s:
  s.settimeout(5);s.connect(str(path));s.sendall((json.dumps(request)+'\n').encode())
  for line in s.makefile('rb'):frames.append((time.monotonic()-start,json.loads(line)))
 return frames
def serving(test,transport,idle=.3):
 directory=tempfile.TemporaryDirectory();test.addCleanup(directory.cleanup);os.chmod(directory.name,0o700)
 path=Path(directory.name)/'r.sock';thread=threading.Thread(target=h.serve,args=(path,idle,transport));thread.start()
 test.addCleanup(thread.join,5)
 for _ in range(200):
  if path.exists():break
  time.sleep(.005)
 return path,thread
class Review(unittest.TestCase):
 def test_stale_pooled_connection_gets_one_fresh_retry(self):
  up=Upstream(lambda s,c,r:(reply(s),'close')[1]);self.addCleanup(up.close)
  with via(up):
   transport=h.Transport();self.addCleanup(transport.close)
   for _ in range(2):self.assertEqual(transport.request('/ns/test/search',{'Authorization':'fixture'},b'{"query":"fresh"}')['status'],200)
  self.assertEqual(up.connections,2)
 def test_retry_and_waits_stay_inside_caller_budget(self):
  up=Upstream(lambda s,c,r:(reply(s),'close')[1] if c==1 else time.sleep(5));self.addCleanup(up.close)
  with via(up):
   transport=h.Transport();self.addCleanup(transport.close)
   transport.request('/ns/test/search',{},b'{}',time.monotonic()+1)
   start=time.monotonic()
   with self.assertRaises(OSError):transport.request('/ns/test/search',{},b'{}',time.monotonic()+.4)
   self.assertLess(time.monotonic()-start,.7);self.assertEqual(up.connections,2)
 def test_slow_trickle_response_hits_total_deadline(self):
  def trickle(s,c,r):
   s.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n')
   for _ in range(60):s.sendall(b'x');time.sleep(.05)
  up=Upstream(trickle);self.addCleanup(up.close)
  with via(up):
   transport=h.Transport();start=time.monotonic()
   with self.assertRaises((OSError,http.client.HTTPException)):transport.request('/ns/test/search',{},b'{}',time.monotonic()+.5)
   self.assertLess(time.monotonic()-start,.9)
 def test_deadline_error_frame_then_worker_ends_and_helper_idles_out(self):
  up=Upstream(lambda s,c,r:[(s.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n'),[(s.sendall(b'x'),time.sleep(.05)) for _ in range(60)])]);self.addCleanup(up.close)
  with via(up):
   path,thread=serving(self,h.Transport())
   frames=ask(path,400)
   self.assertTrue(frames[0][1].get('ready'));self.assertEqual(frames[-1][1],{'v':1,'error':True})
   self.assertLess(frames[-1][0],.8);self.assertTrue(all(f.get('busy') for _,f in frames[1:-1]))
   thread.join(3);self.assertFalse(thread.is_alive());self.assertFalse(path.exists())
 def test_stale_pool_through_helper_still_returns_results(self):
  up=Upstream(lambda s,c,r:(reply(s),'close')[1]);self.addCleanup(up.close)
  with via(up):
   path,_=serving(self,h.Transport(),.2)
   for _ in range(2):
    frames=ask(path,2000);self.assertEqual(frames[-1][1]['status'],200)
  self.assertEqual(up.connections,2)
 def test_connect_that_overruns_the_deadline_sends_nothing(self):
  up=Upstream(lambda s,c,r:reply(s));self.addCleanup(up.close)
  class SlowConnect(http.client.HTTPConnection):
   def connect(self):time.sleep(.4);super().connect()
  with patch.object(h.http.client,'HTTPSConnection',lambda host,timeout=None,context=None:SlowConnect('127.0.0.1',up.port,timeout=timeout)):
   transport=h.Transport();start=time.monotonic()
   with self.assertRaises(TimeoutError):transport.request('/ns/test/search',{},b'{}',time.monotonic()+.2)
   self.assertLess(time.monotonic()-start,.7)
  time.sleep(.1);self.assertEqual(up.requests,0)
 def test_worker_failure_is_reported_without_content(self):
  class Broken:
   def request(self,*a):raise RuntimeError('secret prompt text')
   def close(self):pass
  path,_=serving(self,Broken(),.2);frames=ask(path)
  self.assertEqual([f for _,f in frames],[{'v':1,'ready':True},{'v':1,'error':True}])
 def test_socket_is_private_from_bind_even_if_chmod_is_skipped(self):
  class Idle:
   def close(self):pass
  old=os.umask(0)
  try:
   with patch.object(h.Path,'chmod',lambda *a,**k:None):
    with tempfile.TemporaryDirectory() as d:
     os.chmod(d,0o700);p=Path(d)/'r.sock';thread=threading.Thread(target=h.serve,args=(p,.2,Idle()));thread.start()
     for _ in range(200):
      if p.exists():break
      time.sleep(.005)
     mode=p.stat().st_mode&0o777;thread.join(3)
  finally:os.umask(old)
  self.assertEqual(mode,0o600)
 def test_one_constant_limits_active_requests(self):
  release=threading.Event()
  class Blocking:
   def request(self,*a):release.wait(5);return {'v':1,'status':200,'headers':{},'body':'{}'}
   def close(self):pass
  with patch.object(h,'MAX_ACTIVE',2):
   path,_=serving(self,Blocking(),.2);held=[]
   try:
    for _ in range(2):
     s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(str(path))
     s.sendall((json.dumps({'v':1,'url':'https://api.supermemory.ai/ns/test/search','method':'POST','headers':{},'body':'{}'})+'\n').encode())
     self.assertTrue(json.loads(s.makefile('rb').readline())['ready']);held.append(s)
    with socket.socket(socket.AF_UNIX) as extra:
     extra.settimeout(3);extra.connect(str(path));self.assertEqual(extra.recv(10),b'')
   finally:
    release.set()
    for s in held:s.close()
 def test_tests_do_not_embed_machine_paths(self):
  marker='/ho'+'me/'
  for f in Path(__file__).parent.iterdir():
   if f.suffix in ('.py','.mjs') and f.name!='unit.mjs' and f.name!='e2e-battle-test.mjs':self.assertFalse(marker in f.read_text(),'machine path in '+f.name)
if __name__=='__main__':unittest.main(verbosity=2)

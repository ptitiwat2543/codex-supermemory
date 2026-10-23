from pathlib import Path
import os,json,shutil,subprocess,tempfile,time,hashlib
ROOT=Path(__file__).resolve().parents[1]
NODE=shutil.which('node');assert NODE,'node must be on PATH'
with tempfile.TemporaryDirectory() as d:
 home=Path(d);(home/'.codex').mkdir();runtime=home/'run';runtime.mkdir(mode=0o700)
 (home/'.codex/supermemory.json').write_text('{"recallMode":"direct","debug":true}')
 preload=home/'probe.cjs'
 preload.write_text("""const fs=require('fs'),cp=require('child_process');
const spawn=cp.spawn;
cp.spawn=(exe,args,opts)=>{
 if(exe!=='/usr/bin/python3'||!args.includes('--socket'))throw Error('unexpected spawn');
 if(Object.keys(opts.env).some(k=>/KEY|TOKEN|SECRET/.test(k)))throw Error('credential inherited');
 fs.writeFileSync(process.env.PROOF,JSON.stringify({exe,args,keys:Object.keys(opts.env)}));
 return spawn(exe,[...args,'--idle-seconds','0.3'],opts); // argparse keeps the last value, so the helper exits fast here
};
global.fetch=async(u,i)=>{
 if(!/\\/(search|list\\/(memories|documents))$/.test(new URL(u).pathname))throw Error('not read');
 return new Response(JSON.stringify({results:[{id:'fixture-new',memory:'fresh hook fallback',similarity:.9}],pagination:{totalItems:1},searchTime:1}),{status:200,headers:{'content-type':'application/json'}});
};
""")
 env={'PATH':os.path.dirname(NODE)+':/usr/bin:/bin','HOME':d,'USERPROFILE':d,'XDG_RUNTIME_DIR':str(runtime),'SUPERMEMORY_CODEX_API_KEY':'fixture','PROOF':str(home/'proof.json')}
 payload={'session_id':'test-auto','prompt':'Please recall the routing rules of our application when tests fail.','cwd':d}
 def hook(extra={},session='test-auto'):
  return subprocess.run([NODE,'--require',str(preload),str(ROOT/'dist/hooks/recall.js')],input=json.dumps({**payload,'session_id':session}),text=True,capture_output=True,env={**env,**extra},timeout=5)
 def warm_log():
  # Only the new warm line: the older debug lines are existing behavior and are not part of this check.
  lines=[l for l in (home/'.codex-supermemory.log').read_text().splitlines() if 'recall: warm' in l]
  for l in lines:assert 'routing rules' not in l and 'fixture' not in l,l
  return lines
 x=hook()
 assert x.returncode==0,x.stderr
 assert 'fresh hook fallback' in x.stdout,x.stdout
 proof=json.loads((home/'proof.json').read_text());sock=Path(proof['args'][proof['args'].index('--socket')+1])
 assert proof['args'][1]==str(ROOT/'dist/hooks/recall-warm.py'),proof
 # the hook asks for a helper that outlives the minutes between prompts
 assert '--idle-seconds' in proof['args'] and proof['args'][proof['args'].index('--idle-seconds')+1]=='1800',proof
 seen=False
 for _ in range(150):
  if sock.exists():seen=True
  elif seen:break
  time.sleep(.01)
 assert seen,'helper never started'
 assert not sock.exists(),'helper did not idle exit'
 first=warm_log();assert first and all('"used":false' in l for l in first) and any('"reason":"no-helper"' in l for l in first),first[:3]
 # SUPERMEMORY_RECALL_WARM=0 must switch warm off for real: original search, no helper start, reason logged.
 (home/'proof.json').unlink();before=len(warm_log())
 y=hook({'SUPERMEMORY_RECALL_WARM':'0'},'test-off')
 assert y.returncode==0,y.stderr
 assert 'fresh hook fallback' in y.stdout,y.stdout
 assert not (home/'proof.json').exists(),'helper was started although warm is off'
 time.sleep(.2);assert not sock.exists()
 off=warm_log()[before:];assert off and all('"reason":"disabled-by-env"' in l and '"used":false' in l for l in off),off
 print(json.dumps({'full_hook_fallback':'fresh hits','auto_start':True,'idle_exit':True,'key_not_inherited':True,'env_off_no_helper':True,'warm_log_reason':True}))

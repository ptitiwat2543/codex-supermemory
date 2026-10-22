import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
const require=createRequire(import.meta.url);
const cp=require('node:child_process');
// Same isolation as unit.mjs: the hook modules write ~/.codex-supermemory, so this suite gets a throwaway HOME
// and proves at the end that the real inventory file was not touched.
const REAL_HOME=homedir();
const REAL_INVENTORY=join(REAL_HOME,'.codex-supermemory','namespace-contents.json');
const inventoryState=()=>{try{const s=statSync(REAL_INVENTORY);return s.mtimeMs+':'+createHash('sha256').update(readFileSync(REAL_INVENTORY)).digest('hex');}catch{return 'absent';}};
const inventoryBefore=inventoryState();
const SUITE_HOME=mkdtempSync(join(tmpdir(),'smw-home-'));
process.on('exit',()=>rmSync(SUITE_HOME,{recursive:true,force:true}));
process.env.HOME=SUITE_HOME;process.env.USERPROFILE=SUITE_HOME;
const file='../dist/services/warmRecallTransport.js';
const url='https://api.supermemory.ai/ns/test/search';
const init={method:'POST',headers:{authorization:'Bearer fixture'},body:'{"query":"fresh"}'};
test('each prompt searches again through the helper; no result cache',async t=>{
  const {createWarmFetch}=require(file);
  const root=mkdtempSync(join(tmpdir(),'smw-'));chmodSync(root,0o700);
  const socketPath=join(root,'helper.sock');let calls=0;
  const server=createServer(s=>{let b='';s.on('data',d=>{b+=d;if(!b.includes('\n'))return;
    calls++;s.write('{"v":1,"ready":true}\n');
    s.end(JSON.stringify({v:1,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({results:[{id:String(calls),memory:'fresh '+calls}]})})+'\n');});});
  await new Promise(resolve=>server.listen(socketPath,resolve));chmodSync(socketPath,0o600);
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const fetch=createWarmFetch({socketPath,autoStart:false,direct:async()=>{throw Error('unexpected fallback');}});
  assert.equal((await (await fetch(url,init)).json()).results[0].memory,'fresh 1');
  assert.equal((await (await fetch(url,init)).json()).results[0].memory,'fresh 2');
  assert.equal(calls,2);
});


async function fake(t, handler) { return (await fakeServer(t, handler)).path; }
async function fakeServer(t, handler, at) {
  const root=mkdtempSync(join(tmpdir(),'smw-'));chmodSync(root,0o700);
  const socketPath=at??join(root,'r.sock'), clients=new Set(), stats={connections:0};
  const server=createServer(s=>{stats.connections++;clients.add(s);s.on('error',()=>{});s.on('close',()=>clients.delete(s));
    let input='';s.on('data',b=>{input+=b;if(input.includes('\n')){s.removeAllListeners('data');handler(s,JSON.parse(input));}});});
  await new Promise(resolve=>server.listen(socketPath,resolve));chmodSync(socketPath,0o600);
  t.after(()=>{for(const c of clients)c.destroy();return new Promise(resolve=>server.close(resolve));});
  return {path:socketPath, stats};
}
const hits=()=>new Response(JSON.stringify({results:[{id:'fresh',memory:'new search result',similarity:.9}],searchTime:1}),{status:200,headers:{'content-type':'application/json'}});
const cases={
  'slow readiness':s=>{const timer=setTimeout(()=>s.end('{"v":1,"ready":true}\n'),600);s.on('close',()=>clearTimeout(timer));},
  'dies before ACK':s=>s.destroy(),
  'silent after ACK':s=>s.write('{"v":1,"ready":true}\n'),
  'dies after ACK':s=>{s.write('{"v":1,"ready":true}\n');s.destroy();},
  'wrong ACK shape':s=>s.end('{"v":1,"ready":"true"}\n'),
  'wrong response shape':s=>s.end('{"v":1,"ready":true}\n{"v":1,"status":200,"body":{}}\n'),
  'invalid JSON body':s=>s.end('{"v":1,"ready":true}\n'+JSON.stringify({v:1,status:200,headers:{},body:'not-json'})+'\n'),
};
for(const [name, handler] of Object.entries(cases)) test(name+': original hook search still returns fresh hits',async t=>{
  const socketPath=await fake(t,handler);
  process.env.SUPERMEMORY_CODEX_API_KEY='fixture';process.env.SUPERMEMORY_API_VERSION='v5';process.env.SUPERMEMORY_API_URL='https://api.supermemory.ai';
  const {getHookProfileWithSearchMany}=require('../dist/services/hookRecallClient.js');
  const {createWarmFetch}=require(file);let requests=[];
  const fetchImpl=createWarmFetch({socketPath,autoStart:false,direct:async (u,i)=>{requests.push([u,JSON.parse(i.body)]);return hits();}});
  const start=performance.now();
  const result=await getHookProfileWithSearchMany(['test'],'same query',{writeTags:['test'],fetchImpl,timeoutMs:1500});
  assert.equal(result.success,true);assert.equal(result.searchResults.results[0].memory,'new search result');
  assert.equal(requests.length,1);assert.equal(requests[0][1].query,'same query');
  if(name==='slow readiness')assert.ok(performance.now()-start<450,'must not wait for 600ms ACK');
});
test('absent helper falls back immediately',async()=>{
  const {createWarmFetch}=require(file);let n=0;const start=performance.now();
  const f=createWarmFetch({socketPath:join(tmpdir(),'nonexistent-socket'),autoStart:false,direct:async()=>{n++;return hits();}});
  assert.equal((await (await f(url,init)).json()).results[0].id,'fresh');assert.equal(n,1);assert.ok(performance.now()-start<200);
});
test('HTTP 429 is returned once; no direct retry against provider limit',async t=>{
  const path=await fake(t,s=>s.end('{"v":1,"ready":true}\n'+JSON.stringify({v:1,status:429,headers:{},body:'quota'})+'\n'));
  const {createWarmFetch}=require(file);let n=0;
  const response=await createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}})(url,init);
  assert.equal(response.status,429);assert.equal(n,0);
});
test('caller abort is respected and does not replay a cancelled prompt',async t=>{
  const path=await fake(t,s=>s.write('{"v":1,"ready":true}\n'));
  const {createWarmFetch}=require(file);const controller=new AbortController();let n=0;
  const f=createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}});
  const timer=setTimeout(()=>controller.abort(),30);
  await assert.rejects(f(url,{...init,signal:controller.signal}));clearTimeout(timer);assert.equal(n,0);
});
test('read parameters, Unicode, namespace and new authorization are unchanged',async t=>{
  const got=[];const path=await fake(t,(s,value)=>{got.push(value);s.end('{"v":1,"ready":true}\n'+JSON.stringify({v:1,status:200,headers:{},body:'{"results":[]}'})+'\n');});
  const {createWarmFetch}=require(file);const f=createWarmFetch({socketPath:path,autoStart:false});
  for(const key of ['key-A','key-B'])await f(url,{...init,headers:{authorization:'Bearer '+key},body:JSON.stringify({query:'ความจำใหม่',threshold:.6,searchMode:'hybrid',limit:10})});
  assert.equal(got.length,2);assert.equal(got[1].headers.authorization,'Bearer key-B');
  assert.deepEqual(JSON.parse(got[0].body),{query:'ความจำใหม่',threshold:.6,searchMode:'hybrid',limit:10});
});
test('unsafe socket permissions use original search',async t=>{
  const path=await fake(t,()=>assert.fail('unsafe helper contacted'));chmodSync(path,0o666);
  const {createWarmFetch}=require(file);let n=0;
  await createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}})(url,init);assert.equal(n,1);
});

test('slow provider with live helper keeps original search without fallback',async t=>{
 const path=await fake(t,s=>{s.write('{"v":1,"ready":true}\n');const tick=setInterval(()=>s.write('{"v":1,"busy":true}\n'),70);
 const end=setTimeout(()=>{clearInterval(tick);s.end(JSON.stringify({v:1,status:200,headers:{},body:'{"results":[{"id":"late-fresh"}]}'})+'\n');},450);
 s.on('close',()=>{clearInterval(tick);clearTimeout(end);});});
 const {createWarmFetch}=require(file);let n=0;
 const f=createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}});
 assert.equal((await (await f(url,init)).json()).results[0].id,'late-fresh');assert.equal(n,0);
});

const ready='{"v":1,"ready":true}\n';
test('helper is told the remaining budget, never more than the caller has',async t=>{
  let seen;const path=await fake(t,(s,v)=>{seen=v;s.end(ready+JSON.stringify({v:1,status:200,headers:{},body:'{"results":[]}'})+'\n');});
  const {createWarmFetch}=require(file);
  await createWarmFetch({socketPath:path,autoStart:false,budgetMs:1500,direct:async()=>{throw Error('unexpected fallback');}})(url,init);
  assert.ok(seen.budget_ms>0&&seen.budget_ms<=1500,'budget_ms='+seen.budget_ms);
});
test('heartbeats cannot stretch the request past the caller budget',{timeout:4000},async t=>{
  const path=await fake(t,s=>{s.write(ready);const tick=setInterval(()=>s.write('{"v":1,"busy":true}\n'),70);s.on('close',()=>clearInterval(tick));});
  const {createWarmFetch}=require(file);let n=0;const start=performance.now();
  const response=await createWarmFetch({socketPath:path,autoStart:false,budgetMs:400,direct:async()=>{n++;return hits();}})(url,init);
  assert.equal((await response.json()).results[0].id,'fresh');assert.equal(n,1);assert.ok(performance.now()-start<900);
});
test('helper error frame falls back at once and the helper stays in use',async t=>{
  const {path,stats}=await fakeServer(t,s=>s.end(ready+'{"v":1,"error":true}\n'));
  const {createWarmFetch}=require(file);let n=0;const start=performance.now();
  for(let i=0;i<2;i++)await createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}})(url,init);
  assert.equal(n,2);assert.equal(stats.connections,2);assert.ok(performance.now()-start<300);
});
test('helper that connects but never answers costs one wait per 60s, not per prompt',async t=>{
  const {path,stats}=await fakeServer(t,()=>{});
  const {createWarmFetch}=require(file);let n=0;
  const hook=()=>createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}});
  let start=performance.now();await hook()(url,init);assert.ok(performance.now()-start>=150);
  start=performance.now();await hook()(url,init);assert.ok(performance.now()-start<60,'second prompt waited '+(performance.now()-start));
  assert.equal(stats.connections,1);assert.equal(n,2);
  const marker=join(dirname(path),'stalled'),old=new Date(Date.now()-61_000);utimesSync(marker,old,old);
  await hook()(url,init);assert.equal(stats.connections,2);
});
test('stopped real helper holding the lock does not tax every prompt',async t=>{
  const root=mkdtempSync(join(tmpdir(),'smw-'));chmodSync(root,0o700);const path=join(root,'r.sock');
  const helper=cp.spawn('/usr/bin/python3',['-I',new URL('../src/hooks/recall-warm.py',import.meta.url).pathname,'--socket',path,'--idle-seconds','30'],{stdio:'ignore'});
  t.after(()=>{helper.kill('SIGCONT');helper.kill('SIGKILL');});
  for(let i=0;i<300&&!existsSync(path);i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(existsSync(path),'helper never bound');process.kill(helper.pid,'SIGSTOP');
  const {createWarmFetch}=require(file);let n=0;
  const hook=()=>createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}});
  await hook()(url,init);const start=performance.now();await hook()(url,init);
  assert.equal(n,2);assert.ok(performance.now()-start<60,'second prompt waited '+(performance.now()-start));
});
test('helper start attempts are spaced 60s apart across hook processes',async t=>{
  const root=mkdtempSync(join(tmpdir(),'smw-'));chmodSync(root,0o700);const path=join(root,'none.sock');
  const real=cp.spawn;let spawns=0,fail=false;
  cp.spawn=()=>{spawns++;if(fail)throw Error('spawn failed');return {on(){},unref(){}};};
  t.after(()=>{cp.spawn=real;});
  const {createWarmFetch}=require(file);
  const hook=()=>createWarmFetch({socketPath:path,direct:async()=>hits()});
  await hook()(url,init);await hook()(url,init);assert.equal(spawns,1);
  const marker=join(root,'last-spawn'),old=new Date(Date.now()-61_000);utimesSync(marker,old,old);
  fail=true;await hook()(url,init);assert.equal(spawns,2);
  await hook()(url,init);assert.equal(spawns,2,'a failed start must not retry on the next prompt');
});
const ago=(path,name,seconds)=>{const t=new Date(Date.now()-seconds*1000);utimesSync(join(dirname(path),name),t,t);};
const stalledMarker=path=>existsSync(join(dirname(path),'stalled'));
const localFailures={
  'closed before ACK (ECONNRESET/end)':s=>s.destroy(),
  'closed after ACK':s=>{s.write(ready);s.destroy();},
  'wrong ACK shape':s=>s.end('{"v":1,"ready":"true"}\n'),
  'malformed frame':s=>s.end(ready+'{"v":1,"status":200,"body":{}}\n'),
};
for(const [name,handler] of Object.entries(localFailures)) test('stalled is not written for: '+name+'; only the one prompt falls back',async t=>{
  const {path,stats}=await fakeServer(t,handler);
  const {createWarmFetch}=require(file);let n=0;
  const hook=()=>createWarmFetch({socketPath:path,autoStart:false,direct:async()=>{n++;return hits();}});
  await hook()(url,init);await hook()(url,init);
  assert.equal(stalledMarker(path),false);assert.equal(stats.connections,2);assert.equal(n,2);
});
test('heartbeat silence after ACK writes stalled; ACK silence too',async t=>{
  const {path}=await fakeServer(t,s=>s.write(ready));
  const {createWarmFetch}=require(file);
  await createWarmFetch({socketPath:path,autoStart:false,direct:async()=>hits()})(url,init);
  assert.equal(stalledMarker(path),true);
});
test('stalled older than last-spawn is expired; newer than last-spawn still holds',async t=>{
  const {path,stats}=await fakeServer(t,()=>{});
  const {createWarmFetch}=require(file);
  const hook=()=>createWarmFetch({socketPath:path,autoStart:false,direct:async()=>hits()});
  await hook()(url,init);assert.equal(stats.connections,1);
  writeFileSync(join(dirname(path),'last-spawn'),'x');ago(path,'stalled',20);ago(path,'last-spawn',10);
  await hook()(url,init);assert.equal(stats.connections,2,'a helper started after the stall must be tried');
  // that failure rewrote stalled, so it is newer than last-spawn again
  await hook()(url,init);assert.equal(stats.connections,2,'a fresh stall newer than the last start must be respected');
});
test('every fetch reports used/reason/ms and nothing else',async t=>{
  const reports=[];const onResult=r=>reports.push(r);
  const {createWarmFetch}=require(file);
  const good=await fakeServer(t,s=>s.end(ready+JSON.stringify({v:1,status:200,headers:{},body:'{"results":[]}'})+'\n'));
  await createWarmFetch({socketPath:good.path,autoStart:false,onResult,direct:async()=>{throw Error('unexpected fallback');}})(url,init);
  const silent=await fakeServer(t,()=>{});
  const f=createWarmFetch({socketPath:silent.path,autoStart:false,onResult,direct:async()=>hits()});
  await f(url,init);await f(url,init);
  await createWarmFetch({socketPath:join(tmpdir(),'no-such.sock'),autoStart:false,onResult,direct:async()=>hits()})(url,init);
  await createWarmFetch({socketPath:good.path,autoStart:false,onResult,direct:async()=>hits()})('https://api.supermemory.ai/ns/test/add',init);
  assert.deepEqual(reports.map(r=>[r.used,r.reason]),[[true,'helper'],[false,'ack-timeout'],[false,'stalled-backoff'],[false,'no-helper'],[false,'not-eligible']]);
  for(const r of reports){assert.deepEqual(Object.keys(r).sort(),['ms','reason','used']);assert.equal(typeof r.ms,'number');}
  assert.ok(!JSON.stringify(reports).includes('fixture')&&!JSON.stringify(reports).includes('fresh'));
});
test('SUPERMEMORY_RECALL_WARM=0 really switches the helper off',async t=>{
  const base=mkdtempSync(join(tmpdir(),'smw-'));chmodSync(base,0o700);
  const id=createHash('sha256').update(dirname(fileURLToPath(new URL(file,import.meta.url)))).digest('hex').slice(0,12);
  const dir=join(base,'smr-'+id);mkdirSync(dir,{mode:0o700});
  const {path,stats}=await fakeServer(t,s=>s.end(ready+JSON.stringify({v:1,status:200,headers:{},body:'{"results":[]}'})+'\n'),join(dir,'r.sock'));
  const saved={x:process.env.XDG_RUNTIME_DIR,w:process.env.SUPERMEMORY_RECALL_WARM};
  t.after(()=>{for(const [k,v] of [['XDG_RUNTIME_DIR',saved.x],['SUPERMEMORY_RECALL_WARM',saved.w]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  process.env.XDG_RUNTIME_DIR=base;const {createWarmFetch}=require(file);const reports=[];let n=0;
  const hook=()=>createWarmFetch({autoStart:false,onResult:r=>reports.push(r),direct:async()=>{n++;return hits();}});
  process.env.SUPERMEMORY_RECALL_WARM='0';await hook()(url,init);
  assert.equal(stats.connections,0);assert.equal(n,1);assert.deepEqual([reports[0].used,reports[0].reason],[false,'disabled-by-env']);
  delete process.env.SUPERMEMORY_RECALL_WARM;await hook()(url,init);
  assert.equal(stats.connections,1,'without the switch the same setup does use the helper');assert.equal(reports[1].used,true);
});
test('the real inventory file was not touched by this suite',()=>{
  assert.notEqual(process.env.HOME,REAL_HOME);
  assert.equal(inventoryState(),inventoryBefore);
});

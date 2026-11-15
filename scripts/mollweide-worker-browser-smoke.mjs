import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Uses only the installed browser CLI and an isolated browser session.
const session = process.env.BROWSER_SESSION ?? "moll-worker-impl";
const cli = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const evaluate = code => JSON.parse(cli("eval", code));
cli("open", process.argv[2] ?? "http://localhost:4184");
cli("wait", "--fn", "!!window.timeMachineAgent?.getState().plateModel");
if (evaluate("timeMachineAgent.getState().plateModel.loadedSource") !== "local-demo") {
  evaluate('timeMachineAgent.execute("model.select",{source:"local-demo"})');
  cli("wait", "--fn", 'window.timeMachineAgent?.getState().plateModel.loadStatus === "ready"');
}
const smoke = evaluate(`(async()=>{
 const api=timeMachineAgent, results=[];
 const check=async(id,params,ok=true)=>{const result=await api.execute(id,params);results.push({id,params,result});if(result.ok!==ok)throw new Error(JSON.stringify(result));return result};
 await check('projection.select',{projectionId:'globe'});
 await check('layer.group.setVisibility',{groupId:101,active:false});
 const W=window.Worker;window.__mw=[];
 window.Worker=class extends W{
  constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.packet)window.__mw.push({kind:'ready',at:performance.now(),epochMs:performance.timeOrigin+performance.now(),ticket:e.data.ticket,prepareMs:e.data.prepareMs,packMs:e.data.packMs,sentEpochMs:e.data.sentEpochMs,idleMs:e.data.idleMs})})}
  postMessage(m,...args){if(m.kind==='init')window.__mw.push({kind:'init',at:performance.now()});if(m.kind==='frame')window.__mw.push({kind:'start',at:performance.now(),ticket:m.ticket,age:m.age});return super.postMessage(m,...args)}
 };
 for(const mode of ['mollweide','rectangle','globe','mollweide']){
  await check('projection.select',{projectionId:mode});await check('time.set',{ageMa:100});
  if(mode!=='globe'){
   await check('camera.zoom',{factor:0.7});await check('camera.pan',{deltaX:50,deltaY:-20});await check('camera.reset',{});
   await check('layer.setVisibility',{layerId:2,active:true});
   await check('layer.group.setVisibility',{groupId:101,active:true},false);
  }else await check('camera.zoom',{factor:0.7},false);
 }
 await check('projection.select',{projectionId:'invalid'},false);
 await check('camera.zoom',{factor:0},false);
 await check('time.set',{ageMa:'invalid'},false);
 const initializationCount=window.__mw.filter(x=>x.kind==='init').length;
 if(initializationCount!==1)throw new Error('Expected one resident model worker initialization, got '+initializationCount);
 return {results,initializationCount,model:api.getState().plateModel,workerResources:performance.getEntriesByType('resource').filter(x=>/mollweide|plate-mollweide|mollweide-worker-packet/.test(x.name)).map(x=>({name:x.name,duration:x.duration}))};
})()`);
for (const mode of ["rectangle", "globe", "mollweide"]) {
  cli("select", "#projection-select", mode);
  cli("wait", "--fn", `timeMachineAgent.getState().projection.committedId === "${mode}" && timeMachineAgent.getState().projection.status === "ready"`);
}
cli("click", '[data-action="camera.reset"]');
const performanceResults = evaluate(`(async()=>{
 const api=timeMachineAgent;await api.execute('camera.reset',{});const runs=[];
 for(const from of [100,0]){
  await api.execute('time.set',{ageMa:from});window.__mw.length=0;
  const longtasks=[];const observer=new PerformanceObserver(list=>longtasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));observer.observe({type:'longtask',buffered:false});
  const started=performance.now(),outcomes=[],pending=[];let finalResult;
  for(let i=1;i<=60;i++){
   const due=started+i*50;await new Promise(r=>setTimeout(r,Math.max(0,due-performance.now())));
   const age=from+i/2,sent=performance.now();
   pending.push(api.execute('time.set',{ageMa:age}).then(result=>{if(i===60)finalResult=result;outcomes.push({age,sent,done:performance.now(),ok:result.ok,error:result.error})}));
  }
  await Promise.all(pending);const finished=performance.now();observer.disconnect();
  const confirmed=outcomes.filter(x=>x.ok),gaps=confirmed.slice(1).map((x,i)=>x.done-confirmed[i].done).sort((a,b)=>a-b),latencies=confirmed.map(x=>x.done-x.sent).sort((a,b)=>a-b);
  const worker=window.__mw.slice(),ready=worker.filter(x=>x.kind==='ready'),cpuStarts=worker.filter(x=>x.kind==='start');
  const mean=a=>a.reduce((sum,x)=>sum+x,0)/a.length;
  const overlap=confirmed.slice(0,-1).map(frame=>{const readyA=ready.find(x=>cpuStarts.find(s=>s.ticket===x.ticket)?.age===frame.age);const startB=cpuStarts.find(x=>x.at>(readyA?.at??Infinity));return startB?Math.max(0,frame.done-startB.at):0});
  const state=api.getState().projection;
  if(!finalResult?.ok||state.committedTimeMa!==from+30||state.requestedTimeMa!==from+30)throw new Error('Final exact ticket did not render');
  runs.push({from,to:from+30,actualDurationMs:finished-started,confirmed:confirmed.length,confirmedHz:confirmed.length*1000/(finished-started),steadyHz:(confirmed.length-1)*1000/(confirmed.at(-1).done-confirmed[0].done),p95gapMs:gaps[Math.floor(gaps.length*.95)],p95latencyMs:latencies[Math.floor(latencies.length*.95)],workerPrepareMeanMs:mean(ready.map(x=>x.prepareMs)),workerPackMeanMs:mean(ready.map(x=>x.packMs)),workerIdleMeanMs:mean(ready.map(x=>x.idleMs)),transferMeanMs:mean(ready.map(x=>Math.max(0,x.epochMs-x.sentEpochMs))),cpuGpuOverlapMeanMs:mean(overlap),longtasks,finalResult,state,worker,outcomes});
 }
 return runs;
})()`);
const result = { smoke, uiModeSwitches: ["rectangle", "globe", "mollweide"], uiHome: true, runs: performanceResults };
writeFileSync(process.argv[3] ?? "/tmp/timemachineweb-test/moll-worker-browser-results.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ smokeActions: smoke.results.length, workerInitializations: smoke.initializationCount, model: smoke.model, runs: performanceResults.map(({ worker, outcomes, state, ...summary }) => summary) }, null, 2));
if (performanceResults.some(run => run.confirmedHz < 10 || run.steadyHz < 10)) process.exitCode = 1;

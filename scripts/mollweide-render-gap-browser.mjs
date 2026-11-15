import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Isolated production-browser fault injection; no application debug API.
const session = "moll-gap-fix";
const cli = (...args) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const evaluate = code => JSON.parse(cli("eval", code));
cli("open", process.argv[2] ?? "http://127.0.0.1:4184");
cli("wait", "--fn", "!!window.timeMachineAgent?.getState().plateModel");
if (evaluate("timeMachineAgent.getState().plateModel.loadedSource") !== "local-demo") {
  evaluate('timeMachineAgent.execute("model.select",{source:"local-demo"})');
  cli("wait", "--fn", 'timeMachineAgent.getState().plateModel.loadStatus === "ready"');
}
evaluate(`(()=>{const p=Cesium.CesiumWidget.prototype,old=p.render;p.render=function(...a){window.__gapWidget=this;p.render=old;return old.apply(this,a)};return true})()`);
cli("wait", "--fn", "!!window.__gapWidget");
const result = evaluate(`(async()=>{
 const api=timeMachineAgent,w=window.__gapWidget,s=w.scene,gl=s.context._gl;
 if(!(gl instanceof WebGL2RenderingContext))throw Error('WebGL2 required');
 const log=[],tickets=[],runs=[];let scenario='setup',armCPU=false,onReady;
 const event=(kind,data={})=>log.push({kind,at:performance.now(),scenario,loop:w.useDefaultRenderLoop,...data});
 const send=age=>{const ticket={scenario,age,sent:performance.now()};tickets.push(ticket);event('sent',{age});return api.execute('time.set',{ageMa:age}).then(result=>{Object.assign(ticket,{settled:performance.now(),result});event('settled',{age,result});return result})};
 const onceThrow=()=>{const original=gl.drawElements;gl.drawElements=function(...args){gl.drawElements=original;event('drawElements.throw');throw Error('gap-fix actual WebGL one-shot failure')};s.requestRender()};
 const W=window.Worker;window.Worker=class extends W{
  constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.packet){event('worker.ready',{ticket:e.data.ticket});onReady?.(e.data)}})}
  terminate(){event('worker.cancel.terminate');return super.terminate()}
  postMessage(m,...args){if(m.kind==='init')event('worker.init');if(m.kind==='frame'){event('worker.start',{ticket:m.ticket,age:m.age});if(armCPU){armCPU=false;setTimeout(()=>{event('CPU+4ms.requestRender');onceThrow()},4)}}return super.postMessage(m,...args)}
 };
 s.renderError.addEventListener((_s,error)=>event('renderError',{error:String(error)}));
 const add=s.primitives.add;s.primitives.add=function(p,...args){event('GPU.stage.primitiveAdd');return add.call(this,p,...args)};
 const check=async(id,params)=>{const r=await api.execute(id,params);if(!r.ok)throw Error(JSON.stringify(r));return r};
 await check('projection.select',{projectionId:'globe'});
 await check('layer.group.setVisibility',{groupId:101,active:false});
 await check('projection.select',{projectionId:'mollweide'});
 await check('time.set',{ageMa:100});
 scenario='CPU-gap';armCPU=true;
 const a=send(108),b=send(110);await Promise.all([a,b]);
 const failed=api.getState().projection;await new Promise(r=>setTimeout(r,220));
 const retry=await send(100);runs.push({scenario,failed,retry,after:api.getState().projection,loop:w.useDefaultRenderLoop});
 scenario='CPU-successor-ready';
 // Keep genuine Widget rendering, but defer warm-up/confirmation notifications
 // until the successor CPU packet is observed. Never synthesize postRender.
 const raise=s.postRender.raiseEvent;let readyCount=0,restore=()=>{s.postRender.raiseEvent=raise;onReady=undefined};
 s.postRender.raiseEvent=function(){};
 onReady=()=>{if(++readyCount===2){event('successor.CPU-ready');restore();onceThrow()}};
 const c=send(108);
 while(!log.some(x=>x.scenario===scenario&&x.kind==='GPU.stage.primitiveAdd'))await new Promise(r=>setTimeout(r,1));
 const d=send(109);
 while(!log.some(x=>x.scenario===scenario&&x.kind==='worker.start'&&x.age===109))await new Promise(r=>setTimeout(r,1));
 const e=send(110);
 await Promise.all([c,d,e]);restore();
 const failed2=api.getState().projection;const retry2=await send(100);runs.push({scenario,failed:failed2,retry:retry2,after:api.getState().projection,loop:w.useDefaultRenderLoop});
 scenario='basics';const basics=[];for(const age of [13,25.63,100.6,180])basics.push({age,result:await send(age),state:api.getState().projection});
 return {webgl2:true,loopSource:'actual CesiumWidget.useDefaultRenderLoop (Viewer delegates to this widget)',runs,basics,tickets,log};
})()`);
writeFileSync(process.argv[3] ?? "/tmp/timemachineweb-test/moll-gap-fix-browser.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ runs: result.runs, tickets: result.tickets, basics: result.basics.map(x=>({age:x.age,ok:x.result.ok})) }, null, 2));
for (const run of result.runs) {
  const failed = result.tickets.filter(x=>x.scenario===run.scenario && x.age!==100);
  if (!failed.every(x=>x.result.error?.code===500) || !run.retry.ok || !run.loop || run.failed.committedTimeMa!==100 || run.after.committedTimeMa!==100) process.exitCode=1;
}
if(result.basics.some(x=>!x.result.ok||x.state.committedTimeMa!==x.age))process.exitCode=1;

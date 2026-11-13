import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {callerBaseUrl}=await import(pathToFileURL(path.join(root,'src/caller-auth.mjs')));
const {openPort}=await import(pathToFileURL(path.join(root,'test/port-pool.mjs')));
const internal='synthetic-internal-key-with-sufficient-length';
const caller='synthetic-caller-key-with-sufficient-length';
async function listen(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return server;}
function events(mode){
 const response={id:'resp_fixture',object:'response',status:'in_progress',output:[]};
 if(mode==='custom'){
  const item={id:'ct_fixture',type:'custom_tool_call',call_id:'call_custom',name:'exec',input:'synthetic raw input',status:'completed'};
  return [{type:'response.created',response},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress'}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}];
 }
 const item={id:'fc_fixture',type:'function_call',call_id:'call_fixture',name:'fixture__ping',arguments:'{}',status:'completed'};
 const result=[{type:'response.created',response},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}},
  {type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:'{}'},
  {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:'{}'},
  {type:'response.output_item.done',output_index:0,item}];
 if(mode==='truncated')return result;
 if(mode==='error')return [...result,{type:'error',code:'fixture_stream_failure',message:'Synthetic provider failure.'}];
 const status=mode==='complete'?'completed':mode;
 return [...result,{type:`response.${status}`,response:{...response,status,output:[item],usage:{input_tokens:20,output_tokens:5,total_tokens:25},...(status==='incomplete'?{incomplete_details:{reason:'max_output_tokens'}}:{}),...(status==='failed'?{error:{code:'server_error',message:'Synthetic provider failure.'}}:{})}}];
}
const parse=text=>text.split(/\r?\n\r?\n/).flatMap(frame=>{
 const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
 return !data||data==='[DONE]'?[]:[JSON.parse(data)];
});
test('generic HTTP Responses bypass LiteLLM and preserve tool events and truthful terminals',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'responses-http-fixture-'));
 let mode='complete',gatewayCalls=0;const received=[];const children=[];let logs='';
 const upstream=await listen(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));received.push({url:req.url,body});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const wire=(mode==='custom'?': waiting for complete custom input\n\n':'')+events(mode).map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')+(mode==='truncated'?'':'data: [DONE]\n\n');
  for(let i=0;i<wire.length;i+=43)res.write(wire.slice(i,i+43));res.end();
 });
 const gateway=await listen(async(req,res)=>{gatewayCalls++;for await(const chunk of req){}res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'unexpected_litellm_hop',message:'Responses must use the existing direct forwarder.'}}));});
 const apiPort=await openPort(),routerPort=await openPort();
 const providersFile=path.join(state,'generic-providers.json'),modelsFile=path.join(state,'user-models.json');
 fs.writeFileSync(providersFile,JSON.stringify({version:1,providers:[{id:'venice-responses',displayName:'Synthetic Venice Responses',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,adapter:'openai-responses',headers:{},allowPrivate:true,enabled:true}]}));
 fs.writeFileSync(modelsFile,JSON.stringify({version:1,models:[{slug:'venice-responses/deepseek-v4-1-flash-1017',gatewayModel:'venice-responses-deepseek-v4-1-flash-1017',compHash:'fixture',upstreamModel:'deepseek-v4-1-flash-1017',provider:'venice-responses',listed:true,displayName:'Synthetic 1017',description:'Synthetic local test',priority:100,defaultEffort:'high',reasoningLevels:[{effort:'high',description:'High'}],contextWindow:1000000,autoCompact:850000,inputModalities:['text']}]}));
 const env={PATH:process.env.PATH,HOME:state,CODEX_HOME:path.join(state,'codex'),MODEL_ROUTER_STATE_DIR:state,CODEX_ROUTER_STATE_DIR:state,MODEL_ROUTER_GENERIC_PROVIDERS:providersFile,MODEL_ROUTER_USER_MODELS:modelsFile,CODEX_ROUTER_INTERNAL_KEY:internal,CODEX_ROUTER_CALLER_KEY:caller,CODEX_ROUTER_PORT:String(routerPort),CODEX_ROUTER_API_PORT:String(apiPort),CODEX_ROUTER_API_BASE_URL:`http://127.0.0.1:${apiPort}/v1`,CODEX_ROUTER_GATEWAY_BASE_URL:`http://127.0.0.1:${gateway.address().port}/v1`,CODEX_ROUTER_SHOW_ALL_MODELS:'1',CODEX_ROUTER_QUIET:'1'};
 const base=callerBaseUrl(routerPort,caller);
 try{
  for(const script of ['api-forwarder.mjs','router.mjs']){const child=spawn(process.execPath,[path.join(root,'src',script)],{cwd:root,env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',c=>{logs+=c;});children.push(child);}
  for(const url of [`http://127.0.0.1:${apiPort}/health`,`${base}/models`]){
   let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(url,{headers:{Authorization:`Bearer ${internal}`}});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert(ready,logs);
  }
  for(mode of ['complete','custom','incomplete','failed','error','truncated']){
   const res=await fetch(`${base}/responses`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'venice-responses/deepseek-v4-1-flash-1017',stream:true,input:'Use synthetic ping.',tools:[{type:'namespace',name:'fixture',tools:[{type:'function',name:'ping',parameters:{type:'object',properties:{}}}]},{type:'custom',name:'exec',description:'Synthetic custom tool.'}]})});
   const text=await res.text();assert.equal(res.status,200,text+'\n'+logs);const stream=parse(text);
   assert.equal(gatewayCalls,0,'HTTP Responses reached LiteLLM');
   assert.equal(received.at(-1).url,'/v1/responses');assert.equal(received.at(-1).body.model,'deepseek-v4-1-flash-1017');
   const done=stream.find(e=>e.type==='response.output_item.done');assert(done,text);
   if(mode==='custom'){
    assert.equal(done.item.type,'custom_tool_call');assert.equal(done.item.name,'exec');assert.equal(done.item.input,'synthetic raw input');
    assert.equal(received.at(-1).body.tools.at(-1).type,'custom');
   }else{
    assert.equal(done.item.name,'ping');assert.equal(done.item.namespace,'fixture');
    assert(stream.some(e=>e.type==='response.function_call_arguments.done'));
   }
   if(mode==='complete'||mode==='custom')assert.equal(stream.filter(e=>e.type==='response.completed').length,1);
   else{
    assert(!stream.some(e=>e.type==='response.completed'),'Failure was synthesized as success');
    if(mode==='incomplete'||mode==='failed')assert(stream.some(e=>e.type===`response.${mode}`));
    if(mode==='error')assert(stream.some(e=>e.code==='fixture_stream_failure'));
    if(mode==='truncated')assert(stream.some(e=>e.code==='upstream_stream_incomplete'));
   }
  }
  assert.equal(received.length,6);console.log('6 local fixture requests; 0 provider requests; 0 LiteLLM hops.');
 }finally{
  for(const child of children){if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  for(const server of [upstream,gateway])await new Promise(r=>server.close(r));fs.rmSync(state,{recursive:true,force:true});
 }
});

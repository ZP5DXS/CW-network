import { pipeline, env } from '@huggingface/transformers';

const MODEL=process.env.CWN_AI_MODEL||'onnx-community/SmolLM2-135M-Instruct-ONNX';
const DTYPE=process.env.CWN_AI_DTYPE||'q4f16';
const MAX_RSS_MB=Math.max(160,Number(process.env.CWN_AI_MAX_RSS_MB)||330);
const CACHE_DIR=process.env.CWN_AI_CACHE_DIR||'.cache/transformers';
let pipe=null,busy=false,shuttingDown=false;

try{env.cacheDir=CACHE_DIR}catch{}
function post(msg){try{if(process.send)process.send(msg)}catch{}}
function mem(){const m=process.memoryUsage();return {rssMB:Math.round(m.rss/1024/1024),heapMB:Math.round(m.heapUsed/1024/1024)}}
function sendMemory(){const m=mem();post({type:'memory',...m});if(m.rssMB>MAX_RSS_MB&&!shuttingDown){shuttingDown=true;post({type:'state',state:'FALLBACK',error:`AI worker memory guard ${m.rssMB}MB > ${MAX_RSS_MB}MB`});setTimeout(()=>process.exit(86),100)}}
setInterval(sendMemory,1200).unref();

function progress(info={}){
 const p=Number(info.progress);
 post({type:'progress',status:info.status||null,file:info.file||null,progress:Number.isFinite(p)?p:null,loaded:info.loaded||null,total:info.total||null});
}

async function boot(){
 post({type:'state',state:'LOADING'});sendMemory();
 try{
  pipe=await pipeline('text-generation',MODEL,{dtype:DTYPE,progress_callback:progress});
  post({type:'state',state:'WARMING'});sendMemory();
  await pipe('Reply only CW: TEST',{max_new_tokens:4,do_sample:false,return_full_text:false});
  sendMemory();
  post({type:'state',state:'READY'});
 }catch(err){
  post({type:'state',state:'FALLBACK',error:err?.stack||err?.message||String(err)});
  setTimeout(()=>process.exit(2),250);
 }
}

process.on('message',async m=>{
 if(!m||typeof m!=='object')return;
 if(m.type==='shutdown'){shuttingDown=true;try{if(pipe?.dispose)await pipe.dispose()}catch{};process.exit(0);return}
 if(m.type!=='generate'||!Number.isFinite(Number(m.id)))return;
 if(!pipe||busy){post({type:'result',id:m.id,ok:false,text:'',error:'AI worker busy/not ready'});return}
 busy=true;const started=Date.now();
 try{
  const out=await pipe(String(m.prompt||''),{
   max_new_tokens:24,
   temperature:.70,
   top_p:.85,
   repetition_penalty:1.06,
   return_full_text:false
  });
  const text=Array.isArray(out)?String(out[0]?.generated_text||''):'';
  sendMemory();
  post({type:'result',id:m.id,ok:!!text,text,ms:Date.now()-started});
 }catch(err){
  post({type:'result',id:m.id,ok:false,text:'',error:err?.message||String(err),ms:Date.now()-started});
 }finally{busy=false}
});

process.on('disconnect',()=>process.exit(0));
boot();

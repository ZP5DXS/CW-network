import { pipeline, env } from '@huggingface/transformers';

const PRIMARY_MODEL=process.env.CWN_AI_MODEL||'onnx-community/SmolLM-135M-Instruct-ONNX';
const PRIMARY_DTYPE=(process.env.CWN_AI_DTYPE||'int8').toLowerCase();
const MAX_RSS_MB=Math.max(160,Number(process.env.CWN_AI_MAX_RSS_MB)||320);
const CACHE_DIR=process.env.CWN_AI_CACHE_DIR||'.cache/transformers';
const MAX_NEW_TOKENS=Math.max(8,Math.min(28,Number(process.env.CWN_AI_MAX_NEW_TOKENS)||20));
const ALLOW_MODEL_FALLBACK=process.env.CWN_AI_MODEL_FALLBACK!=='0';
let pipe=null,busy=false,shuttingDown=false,selectedModel=null,selectedDtype=null;
let peakRssMB=0,inferences=0,bootStartedAt=Date.now();

try{env.cacheDir=CACHE_DIR}catch{}
function post(msg){try{if(process.send)process.send(msg)}catch{}}
function mem(){const m=process.memoryUsage();const rssMB=Math.round(m.rss/1024/1024),heapMB=Math.round(m.heapUsed/1024/1024);peakRssMB=Math.max(peakRssMB,rssMB);return {rssMB,heapMB,peakRssMB}}
function sendMemory(){const m=mem();post({type:'memory',...m});if(m.rssMB>MAX_RSS_MB&&!shuttingDown){shuttingDown=true;post({type:'state',state:'FALLBACK',error:`AI worker memory guard ${m.rssMB}MB > ${MAX_RSS_MB}MB`});setTimeout(()=>process.exit(86),80)}}
setInterval(sendMemory,500).unref();

function progress(info={}){
 const p=Number(info.progress);
 post({type:'progress',status:info.status||null,file:info.file||null,progress:Number.isFinite(p)?p:null,loaded:info.loaded||null,total:info.total||null,model:selectedModel||PRIMARY_MODEL,dtype:selectedDtype||PRIMARY_DTYPE});
}
function shortError(err){return String(err?.message||err||'unknown error').replace(/\s+/g,' ').slice(0,500)}

async function tryLoad(model,dtype,index){
 selectedModel=model;selectedDtype=dtype;
 post({type:'attempt',index,model,dtype});
 sendMemory();
 const candidate=await pipeline('text-generation',model,{dtype,progress_callback:progress});
 sendMemory();
 return candidate;
}

async function boot(){
 post({type:'state',state:'LOADING'});sendMemory();
 // q4f16/fp16 are deliberately avoided on Node/onnxruntime because mixed-precision
 // graphs can fail during session initialization. int8 is the conservative CPU path.
 const candidates=[{model:PRIMARY_MODEL,dtype:PRIMARY_DTYPE}];
 if(ALLOW_MODEL_FALLBACK){
  const fallbacks=[
   {model:'onnx-community/SmolLM-135M-Instruct-ONNX',dtype:'int8'},
   {model:'onnx-community/SmolLM2-135M-Instruct-ONNX',dtype:'int8'}
  ];
  for(const c of fallbacks)if(!candidates.some(x=>x.model===c.model&&x.dtype===c.dtype))candidates.push(c);
 }
 const failures=[];
 for(let i=0;i<candidates.length;i++){
  const c=candidates[i];
  try{
   pipe=await tryLoad(c.model,c.dtype,i+1);
   selectedModel=c.model;selectedDtype=c.dtype;
   post({type:'selected',model:selectedModel,dtype:selectedDtype,attempt:i+1});
   post({type:'state',state:'WARMING'});sendMemory();
   const warmPrompt='CW ONLY. CALL K1TEST. REPLY TO ZP5DXS WITH RST 579 AND 73.';
   await pipe(warmPrompt,{max_new_tokens:6,do_sample:false,return_full_text:false});
   sendMemory();
   post({type:'state',state:'READY',model:selectedModel,dtype:selectedDtype,bootMs:Date.now()-bootStartedAt});
   return;
  }catch(err){
   failures.push({model:c.model,dtype:c.dtype,error:shortError(err)});
   post({type:'attempt-failed',index:i+1,model:c.model,dtype:c.dtype,error:shortError(err)});
   try{if(pipe?.dispose)await pipe.dispose()}catch{};pipe=null;
   if(shuttingDown)return;
  }
 }
 const error='All AI model attempts failed: '+failures.map(x=>`${x.model} [${x.dtype}]: ${x.error}`).join(' | ');
 post({type:'state',state:'FALLBACK',error,failures});
 setTimeout(()=>process.exit(2),250);
}

process.on('message',async m=>{
 if(!m||typeof m!=='object')return;
 if(m.type==='shutdown'){shuttingDown=true;try{if(pipe?.dispose)await pipe.dispose()}catch{};process.exit(0);return}
 if(m.type!=='generate'||!Number.isFinite(Number(m.id)))return;
 if(!pipe||busy){post({type:'result',id:m.id,ok:false,text:'',error:'AI worker busy/not ready'});return}
 busy=true;const started=Date.now();
 try{
  const out=await pipe(String(m.prompt||''),{
   max_new_tokens:MAX_NEW_TOKENS,
   do_sample:true,
   temperature:.68,
   top_p:.86,
   repetition_penalty:1.08,
   return_full_text:false
  });
  let text='';
  if(Array.isArray(out)){
   const g=out[0]?.generated_text;
   if(typeof g==='string')text=g;
   else if(Array.isArray(g))text=String(g.at(-1)?.content||'');
  }
  inferences++;sendMemory();
  post({type:'result',id:m.id,ok:!!text,text,ms:Date.now()-started,model:selectedModel,dtype:selectedDtype,inferences});
 }catch(err){
  post({type:'result',id:m.id,ok:false,text:'',error:shortError(err),ms:Date.now()-started,model:selectedModel,dtype:selectedDtype});
 }finally{busy=false}
});

process.on('disconnect',()=>process.exit(0));
boot();

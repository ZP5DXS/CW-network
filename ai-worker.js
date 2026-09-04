import { pipeline } from '@huggingface/transformers';

const MODEL=process.env.CWN_AI_MODEL||'onnx-community/SmolLM2-135M-Instruct-ONNX-MHA';
let pipe=null;
let busy=false;

function post(msg){try{if(process.send)process.send(msg)}catch{}}

async function boot(){
 post({type:'state',state:'LOADING'});
 try{
  pipe=await pipeline('text-generation',MODEL,{dtype:'q4'});
  post({type:'state',state:'READY'});
 }catch(err){
  post({type:'state',state:'FALLBACK',error:err?.message||String(err)});
  setTimeout(()=>process.exit(2),250);
 }
}

process.on('message',async m=>{
 if(!m||m.type!=='generate'||!Number.isFinite(Number(m.id)))return;
 if(!pipe||busy){post({type:'result',id:m.id,ok:false,text:''});return}
 busy=true;
 try{
  const out=await pipe(String(m.prompt||''),{
   max_new_tokens:48,
   temperature:.78,
   top_p:.90,
   repetition_penalty:1.08,
   return_full_text:false
  });
  const text=Array.isArray(out)?String(out[0]?.generated_text||''):'';
  post({type:'result',id:m.id,ok:!!text,text});
 }catch(err){
  post({type:'result',id:m.id,ok:false,text:'',error:err?.message||String(err)});
 }finally{busy=false}
});

process.on('disconnect',()=>process.exit(0));
boot();

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const PORT=Number(process.env.PORT||10000);
const VALID_BANDS=new Set([40,20,15,10]);
const BAND_LIMITS={40:[7030000,7040000],20:[14025000,14035000],15:[21025000,21035000],10:[28020000,28030000]};
const SERVICE_FREQ={40:7031500,20:14026500,15:21026500,10:28021500};
const clients=new Map(), recentBandTx=new Map([...VALID_BANDS].map(b=>[b,[]]));
let serverSeq=0;
let spaceWeather={type:'space_weather',kp:null,sfi:null,updated:null,source:'NOAA SWPC'};

const MORSE={
 A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',
 '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','/':'-..-.','?':'..--..'
};
const MORSE_INV=Object.fromEntries(Object.entries(MORSE).map(([k,v])=>[v,k]));
const id=(p='st')=>p+'_'+crypto.randomBytes(6).toString('hex');
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const safeText=(v,n=32)=>String(v??'').replace(/[^A-Z0-9/\- ?.,]/gi,'').toUpperCase().slice(0,n);
function send(ws,obj){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function broadcast(obj,except=null){const raw=JSON.stringify(obj);for(const [ws] of clients)if(ws!==except&&ws.readyState===WebSocket.OPEN)ws.send(raw)}
function broadcastBand(b,obj,except=null){
 const raw=JSON.stringify(obj);
 for(const [ws,state] of clients){
  if(ws!==except&&state.band===b&&ws.readyState===WebSocket.OPEN)ws.send(raw);
 }
}
function wsForStation(stationId){for(const [ws,s] of clients)if(s.stationId===stationId)return ws;return null}
function publicState(s){return {stationId:s.stationId,kind:s.kind,callsign:s.callsign,locator:s.locator,band:s.band,hz:s.hz,power:s.power,antenna:s.antenna,azimuth:s.azimuth,wpm:s.wpm,keyMode:s.keyMode,iambicMode:s.iambicMode,role:s.role||null,keyDown:!!s.keyDown}}
function recordTx(b){const now=Date.now(),a=recentBandTx.get(b)||[];a.push(now);while(a.length&&a[0]<now-120000)a.shift();recentBandTx.set(b,a)}
function activityLevel(b){const now=Date.now(),a=(recentBandTx.get(b)||[]).filter(t=>t>=now-120000);const n=[...clients.values()].filter(s=>s.band===b).length+[...bots.values()].filter(s=>s.active&&s.band===b).length;const score=a.length+n*2;return score>=45?'HIGH':score>=14?'MED':'LOW'}
function presence(){const activity={};for(const b of VALID_BANDS)activity[b]=activityLevel(b);broadcast({type:'presence',online:clients.size,activity})}
function sanitizeState(m,prev={}){
 const band=VALID_BANDS.has(+m.band)?+m.band:(prev.band||40),[lo,hi]=BAND_LIMITS[band];
 return {...prev,callsign:safeText(m.callsign||prev.callsign||'',16),locator:safeText(m.locator||prev.locator||'',10),visitorId:String(m.visitorId||prev.visitorId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80),band,
 hz:clamp(Math.round(Number(m.hz)||((lo+hi)/2)),lo,hi),power:clamp(Math.round(Number(m.power)||10),1,100),
 antenna:+m.antenna===1?1:2,azimuth:((Math.round(Number(m.azimuth)||0)%360)+360)%360,
 wpm:clamp(Math.round(Number(m.wpm)||15),5,45),keyMode:m.keyMode==='PADDLE'?'PADDLE':'STRAIGHT',
 iambicMode:['A','B','BUG'].includes(m.iambicMode)?m.iambicMode:'A'};
}
function rateOK(state,type){
 const now=Date.now();state.rate=state.rate||{t:now,key:0,msg:0};
 if(now-state.rate.t>=1000)state.rate={t:now,key:0,msg:0};
 if(type==='key_down'||type==='key_up'){state.rate.key++;return state.rate.key<=110}
 state.rate.msg++;return state.rate.msg<=40;
}

const SERVER_STARTED_AT=new Date().toISOString();
const AI_ENABLED=process.env.CWN_AI_ENABLED!=='0';
const AI_DEBUG=process.env.CWN_AI_DEBUG==='1';
const GEMINI_API_KEY=String(process.env.GEMINI_API_KEY||'').trim();
const ADMIN_TOKEN=String(process.env.CWN_ADMIN_TOKEN||'').trim();
const CONFIGURED_AI_MODEL=String(process.env.CWN_AI_MODEL||'gemini-3.1-flash-lite').trim();
const AI_MODEL=CONFIGURED_AI_MODEL.startsWith('onnx-community/')?'gemini-3.1-flash-lite':CONFIGURED_AI_MODEL;
const AI_FALLBACK_MODEL='gemini-3.1-flash-lite';
const AI_TIMEOUT_MS=clamp(Number(process.env.CWN_AI_TIMEOUT_MS)||6000,2500,15000);
const AI_MAX_QUEUE=clamp(Number(process.env.CWN_AI_MAX_QUEUE)||4,1,12);
const AI_HISTORY_LIMIT=50;
const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const SUPABASE_SERVICE_ROLE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
const STATS_DB_READY=!!(SUPABASE_URL&&SUPABASE_SERVICE_ROLE_KEY);
let statsCache={users:0,countries:0,usage_seconds:0,likes:0,qsos:0,qso_bot:0,qso_human:0,avg_wpm:0,qrs:0,qrq:0,max_distance_km:0,top_callsigns:[],persistent:STATS_DB_READY};
const countryCache=new Map(),humanQsoPairs=new Map(),humanQsoCompleted=new Map();

async function supabaseRpc(fn,body={}){
 if(!STATS_DB_READY)return null;
 const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`,{method:'POST',headers:{'content-type':'application/json','apikey':SUPABASE_SERVICE_ROLE_KEY,'authorization':`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`},body:JSON.stringify(body)});
 if(!r.ok)throw new Error(`Supabase ${fn} HTTP ${r.status}: ${(await r.text()).slice(0,240)}`);
 const txt=await r.text();try{return txt?JSON.parse(txt):null}catch{return txt}
}
async function refreshStatsCache(){
 if(!STATS_DB_READY){statsCache={...statsCache,users:new Set([...clients.values()].map(s=>s.visitorId).filter(Boolean)).size,persistent:false};broadcast({type:'stats',...statsCache});return;}
 try{const data=await supabaseRpc('cwn_get_stats',{});if(data&&typeof data==='object')statsCache={...statsCache,...data,persistent:true};broadcast({type:'stats',...statsCache});}
 catch(err){console.error('stats refresh:',err?.message||err)}
}
function clientIp(req){const x=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();return x||String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'')}
async function countryForIp(ip){
 if(!ip||ip==='127.0.0.1'||ip==='::1')return {code:'',name:''};if(countryCache.has(ip))return countryCache.get(ip);
 let out={code:'',name:''};try{const r=await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,country`,{headers:{'user-agent':'CW-Network/0.40'}});const j=await r.json();if(j?.success!==false)out={code:String(j?.country_code||'').slice(0,2),name:String(j?.country||'').slice(0,64)}}catch(_){}
 countryCache.set(ip,out);setTimeout(()=>countryCache.delete(ip),6*60*60*1000);return out;
}
function maidenheadToLatLonServer(locator){
 const s=String(locator||'').trim().toUpperCase();if(!/^[A-R]{2}[0-9]{2}([A-X]{2})?([0-9]{2})?$/.test(s))return null;
 let lon=-180+(s.charCodeAt(0)-65)*20,lat=-90+(s.charCodeAt(1)-65)*10,lonSize=20,latSize=10;
 lon+=Number(s[2])*2;lat+=Number(s[3]);lonSize=2;latSize=1;
 if(s.length>=6){lon+=(s.charCodeAt(4)-65)/12;lat+=(s.charCodeAt(5)-65)/24;lonSize=1/12;latSize=1/24}
 if(s.length>=8){lon+=Number(s[6])/120;lat+=Number(s[7])/240;lonSize=1/120;latSize=1/240}
 return {lat:lat+latSize/2,lon:lon+lonSize/2};
}
function distanceKmLoc(a,b){
 const A=maidenheadToLatLonServer(a),B=maidenheadToLatLonServer(b);if(!A||!B)return null;
 const R=6371,rad=x=>x*Math.PI/180,dLat=rad(B.lat-A.lat),dLon=rad(B.lon-A.lon),h=Math.sin(dLat/2)**2+Math.cos(rad(A.lat))*Math.cos(rad(B.lat))*Math.sin(dLon/2)**2;
 return Math.round(R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)));
}
async function touchVisitor(state,usageSeconds=0){
 if(!state?.visitorId||!STATS_DB_READY)return;
 try{await supabaseRpc('cwn_touch_visitor',{p_visitor_id:state.visitorId,p_country_code:state.countryCode||'',p_country:state.country||'',p_callsign:state.callsign||'',p_locator:state.locator||'',p_usage_seconds:Math.max(0,Math.round(usageSeconds)),p_wpm:clamp(Math.round(Number(state.wpm)||15),5,45)});}
 catch(err){console.error('touch visitor:',err?.message||err)}
}
async function recordRequestStat(state,kind){if(!state?.visitorId||!STATS_DB_READY)return;try{await supabaseRpc('cwn_record_request',{p_visitor_id:state.visitorId,p_kind:kind})}catch(err){console.error('request stat:',err?.message||err)}}
async function recordLikeStat(state,liked){if(!state?.visitorId||!STATS_DB_READY)return;try{await supabaseRpc('cwn_set_like',{p_visitor_id:state.visitorId,p_liked:!!liked});await refreshStatsCache()}catch(err){console.error('like stat:',err?.message||err)}}
async function recordQsoStat(kind,a,b,band){
 const distance=distanceKmLoc(a?.locator,b?.locator);
 if(STATS_DB_READY)try{await supabaseRpc('cwn_record_qso',{p_kind:kind,p_visitor_a:a?.visitorId||null,p_visitor_b:b?.visitorId||null,p_callsign_a:a?.callsign||'',p_callsign_b:b?.callsign||'',p_locator_a:a?.locator||'',p_locator_b:b?.locator||'',p_distance_km:distance,p_band:Number(band)||null,p_wpm_a:Math.round(Number(a?.wpm)||0),p_wpm_b:Math.round(Number(b?.wpm)||0)});await refreshStatsCache()}catch(err){console.error('qso stat:',err?.message||err)}
 return distance;
}

let aiState=!AI_ENABLED?'DISABLED':(!GEMINI_API_KEY?'NO_KEY':'CONFIGURED');
let aiBusy=false,aiReqSeq=0,aiLastError='',aiReadyAt=null,aiActiveModel=AI_MODEL;
const aiQueue=[];
const aiTrace=[];
const aiHistory=[];
const aiStats={
 requests:0,humanRequests:0,botRequests:0,manualRequests:0,probeRequests:0,
 success:0,fallbacks:0,timeouts:0,rateLimited:0,errors:0,busyFallbacks:0,
 inputTokens:0,outputTokens:0,totalTokens:0,
 latencyMsTotal:0,lastLatencyMs:null,maxLatencyMs:0,lastRequestAt:null,lastSuccessAt:null
};
let aiLastPrompt='',aiLastOutput='',aiLastFinal='',aiLastSource='',aiLastStage='';

function traceAI(event,data={}){
 const row={at:new Date().toISOString(),event,...data};
 aiTrace.push(row);if(aiTrace.length>60)aiTrace.shift();
 console.log('[AI]',event,JSON.stringify(data));
}
function pushAIHistory(row){
 aiHistory.push({at:new Date().toISOString(),...row});
 if(aiHistory.length>AI_HISTORY_LIMIT)aiHistory.shift();
}
function shortErr(v){return String(v?.message||v||'unknown error').replace(/\s+/g,' ').slice(0,500)}
function extractGeminiText(data){
 return (data?.candidates?.[0]?.content?.parts||[]).map(p=>typeof p?.text==='string'?p.text:'').join(' ').trim();
}
function usageFrom(data){
 const u=data?.usageMetadata||{};
 return {
  input:Number(u.promptTokenCount||0),
  output:Number(u.candidatesTokenCount||0),
  total:Number(u.totalTokenCount||0)
 };
}
async function callGeminiOnce(model,prompt,timeout=AI_TIMEOUT_MS){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeout);
 const started=Date.now();
 try{
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
   method:'POST',
   headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY},
   body:JSON.stringify({
    contents:[{role:'user',parts:[{text:String(prompt||'')}]}],
    generationConfig:{
     temperature:.72,
     topP:.90,
     maxOutputTokens:120
    }
   }),
   signal:controller.signal
  });
  const raw=await r.text();
  let data={};try{data=raw?JSON.parse(raw):{}}catch{data={raw:raw.slice(0,800)}}
  const ms=Date.now()-started;
  if(!r.ok){
   const e=new Error(data?.error?.message||`Gemini HTTP ${r.status}`);
   e.status=r.status;e.data=data;e.ms=ms;throw e;
  }
  return {ok:true,text:extractGeminiText(data),usage:usageFrom(data),data,ms,model,status:r.status};
 }finally{clearTimeout(timer)}
}
async function callGemini(prompt,{timeout=AI_TIMEOUT_MS}={}){
 if(!AI_ENABLED)throw new Error('AI disabled');
 if(!GEMINI_API_KEY)throw new Error('GEMINI_API_KEY missing');
 const models=[AI_MODEL];
 if(AI_FALLBACK_MODEL!==AI_MODEL)models.push(AI_FALLBACK_MODEL);
 let lastErr=null;
 for(let i=0;i<models.length;i++){
  try{
   const result=await callGeminiOnce(models[i],prompt,timeout);
   aiActiveModel=result.model;
   return result;
  }catch(err){
   lastErr=err;
   const status=Number(err?.status||0);
   traceAI('provider-attempt-failed',{model:models[i],status,error:shortErr(err)});
   // New Gemini projects may not have access to older 2.5 models. Fall through to 3.1 Flash-Lite.
   if(!(status===404||status===400||status===403) || i===models.length-1)break;
  }
 }
 throw lastErr||new Error('Gemini request failed');
}
function pumpAIQueue(){
 if(aiBusy||!aiQueue.length)return;
 const q=aiQueue.shift();
 aiBusy=true;
 (async()=>{
  const started=Date.now();let result=null,error=null;
  try{
   result=await callGemini(q.prompt,{timeout:q.timeout});
   const ms=result.ms??(Date.now()-started),u=result.usage||{input:0,output:0,total:0};
   aiState='READY';aiReadyAt=aiReadyAt||new Date().toISOString();aiLastError='';
   aiStats.success++;aiStats.lastSuccessAt=new Date().toISOString();
   aiStats.inputTokens+=u.input;aiStats.outputTokens+=u.output;aiStats.totalTokens+=u.total;
   aiStats.lastLatencyMs=ms;aiStats.latencyMsTotal+=ms;aiStats.maxLatencyMs=Math.max(aiStats.maxLatencyMs,ms);
   aiLastOutput=result.text||'';
   pushAIHistory({
    id:q.id,source:q.source,stage:q.stage,model:result.model,status:'OK',latencyMs:ms,
    inputTokens:u.input,outputTokens:u.output,totalTokens:u.total,
    prompt:q.prompt.slice(0,1200),rawOutput:(result.text||'').slice(0,800),finalCW:q.finalCW||null
   });
   traceAI('generation-ok',{id:q.id,source:q.source,stage:q.stage,model:result.model,ms,inputTokens:u.input,outputTokens:u.output});
  }catch(err){
   error=err;const status=Number(err?.status||0);
   aiLastError=shortErr(err);
   if(err?.name==='AbortError'){aiStats.timeouts++;aiState='DEGRADED'}
   else if(status===429){aiStats.rateLimited++;aiState='RATE_LIMITED'}
   else{aiStats.errors++;aiState='DEGRADED'}
   pushAIHistory({
    id:q.id,source:q.source,stage:q.stage,model:aiActiveModel,status:`ERROR ${status||''}`.trim(),
    latencyMs:Date.now()-started,inputTokens:0,outputTokens:0,totalTokens:0,
    prompt:q.prompt.slice(0,1200),rawOutput:'',error:aiLastError
   });
   traceAI('generation-failed',{id:q.id,source:q.source,stage:q.stage,status,error:aiLastError});
  }finally{
   aiBusy=false;
   q.resolve(result?.text||null);
   pumpAIQueue();
  }
 })();
}
function requestAI(prompt,{timeout=AI_TIMEOUT_MS,source='human',stage='QSO'}={}){
 aiStats.requests++;aiStats.lastRequestAt=new Date().toISOString();
 if(source==='human')aiStats.humanRequests++;
 else if(source==='bot')aiStats.botRequests++;
 else if(source==='manual')aiStats.manualRequests++;
 else if(source==='probe')aiStats.probeRequests++;
 aiLastPrompt=String(prompt||'').slice(0,1600);aiLastSource=source;aiLastStage=stage;
 if(!AI_ENABLED||!GEMINI_API_KEY){aiStats.fallbacks++;return Promise.resolve(null)}
 return new Promise(resolve=>{
  const item={id:++aiReqSeq,prompt:String(prompt||''),timeout:clamp(Number(timeout)||AI_TIMEOUT_MS,2500,15000),source,stage,resolve};
  if(source==='human'){
   const firstBot=aiQueue.findIndex(x=>x.source!=='human'&&x.source!=='manual');
   if(firstBot>=0)aiQueue.splice(firstBot,0,item);else aiQueue.push(item);
  }else if(source==='manual')aiQueue.unshift(item);
  else aiQueue.push(item);
  while(aiQueue.length>AI_MAX_QUEUE){
   const drop=aiQueue.pop();aiStats.busyFallbacks++;aiStats.fallbacks++;drop.resolve(null);
  }
  pumpAIQueue();
 });
}
function aiDebugSnapshot(full=false,authorized=false){
 const avg=aiStats.success?Math.round(aiStats.latencyMsTotal/aiStats.success):null;
 const base={
  ok:true,service:'CW Network AI',version:'0.40',provider:'google-gemini',
  state:aiState,enabled:AI_ENABLED,keyConfigured:!!GEMINI_API_KEY,
  configuredModel:AI_MODEL,activeModel:aiActiveModel,fallbackModel:AI_FALLBACK_MODEL,
  busy:aiBusy,queue:aiQueue.map(x=>({id:x.id,source:x.source,stage:x.stage})),
  readyAt:aiReadyAt,error:aiLastError||null,
  stats:{...aiStats,avgLatencyMs:avg},
  main:{rssMB:Math.round(process.memoryUsage().rss/1024/1024),heapMB:Math.round(process.memoryUsage().heapUsed/1024/1024),uptime:Math.round(process.uptime())},
  last:{source:aiLastSource||null,stage:aiLastStage||null,latencyMs:aiStats.lastLatencyMs,finalCW:aiLastFinal||null},
  trace:aiTrace.slice(-20),
  history:authorized?aiHistory.slice(-50).reverse().map(x=>({...x,prompt:full?x.prompt:undefined,rawOutput:full?x.rawOutput:undefined})):undefined,
  debugContent:!!(full&&authorized&&AI_DEBUG)
 };
 if(full&&authorized&&AI_DEBUG){base.last.prompt=aiLastPrompt||null;base.last.output=aiLastOutput||null}
 return base;
}
async function probeGemini(){
 if(!AI_ENABLED||!GEMINI_API_KEY)return;
 const text=await requestAI('Reply with exactly: CWN AI READY',{timeout:5000,source:'probe',stage:'HEALTH'});
 if(text){aiState='READY';traceAI('probe-ok',{model:aiActiveModel,reply:String(text).slice(0,80)})}
 else traceAI('probe-failed',{error:aiLastError||'no response'});
}
setTimeout(probeGemini,1800);

const personaStyles=[
 {role:'SKCC',wpm:[13,13],keyMode:'STRAIGHT',tone:'friendly traditional SKCC-style operator'},
 {role:'POTA',wpm:[13,13],keyMode:'PADDLE',tone:'concise portable activator calling CQ POTA'},
 {role:'SOTA',wpm:[13,13],keyMode:'PADDLE',tone:'concise summit activator calling CQ SOTA'},
 {role:'CQ',wpm:[13,13],keyMode:'PADDLE',tone:'general CW operator calling CQ'},
 {role:'DX',wpm:[13,13],keyMode:'PADDLE',tone:'concise DX operator calling CQ DX'}
];
const botNames=['LEO','ANA','MATEO','LUIS','CARLOS','DIEGO','SAM','JEAN','MIKE','PAUL','KEN','AKI','ROB','JAN','TOM','ELI','NICO','MAX','IVAN','LUCA'];
const botLocations=[
 {qth:'ASUNCION',locator:'GG14'},{qth:'BUENOS AIRES',locator:'GF05'},{qth:'MONTEVIDEO',locator:'GF15'},
 {qth:'SAO PAULO',locator:'GG66'},{qth:'SANTIAGO',locator:'FF46'},{qth:'LIMA',locator:'FH17'},
 {qth:'BOGOTA',locator:'FJ24'},{qth:'MIAMI',locator:'EL95'},{qth:'NEW YORK',locator:'FN31'},
 {qth:'MADRID',locator:'IN80'},{qth:'PARIS',locator:'JN18'},{qth:'LONDON',locator:'IO91'},
 {qth:'TOKYO',locator:'PM95'},{qth:'SYDNEY',locator:'QF56'},{qth:'AMSTERDAM',locator:'JO21'}
];
const callLetters='ABCDEFGHJKLMNPQRSTUVWXYZ';
const callSeen=new Set();
const pickLetter=()=>callLetters[Math.floor(Math.random()*callLetters.length)];
const pickDigit=()=>String(Math.floor(Math.random()*9)+1);
function virtualCall(){
 let call;
 do{
  // Keep virtual calls short and easy to copy in CW:
  // 65%: two letters + one digit + two/three letters (e.g. LU7DX, PY2ABC)
  // 35%: letter + digit + two/three letters (e.g. K1CW, G3ABC)
  if(Math.random()<.65){
   call=pickLetter()+pickLetter()+pickDigit()+pickLetter()+pickLetter()+(Math.random()<.30?pickLetter():'');
  }else{
   call=pickLetter()+pickDigit()+pickLetter()+pickLetter()+(Math.random()<.30?pickLetter():'');
  }
 }while(callSeen.has(call));
 callSeen.add(call);return call;
}
function randomFreq(b){
 const [lo,hi]=BAND_LIMITS[b];let hz;
 do{hz=Math.round((lo+450+(Math.random()*(hi-lo-900)))/50)*50}while(Math.abs(hz-SERVICE_FREQ[b])<450);
 return hz;
}
function frequencyFree(b,hz,exclude=''){
 return ![...clients.values(),...bots.values()].some(s=>
  s.stationId!==exclude&&s.band===b&&s.active!==false&&Math.abs((s.hz||0)-hz)<520
 );
}
function randomFreeFreq(b,exclude=''){
 const [lo,hi]=BAND_LIMITS[b];
 for(let i=0;i<28;i++){
  const f=Math.round((lo+650+Math.random()*(hi-lo-1300))/50)*50;
  if(Math.abs(f-SERVICE_FREQ[b])<650)continue;
  if(frequencyFree(b,f,exclude))return f;
 }
 return randomFreq(b);
}

function makeBot(b,index){
 const p=personaStyles[index%personaStyles.length];
 const wpm=13;
 const loc=botLocations[Math.floor(Math.random()*botLocations.length)];
 return {stationId:id('v'),kind:'virtual',callsign:virtualCall(),locator:loc.locator,
 band:b,hz:randomFreq(b),homeHz:0,power:10+Math.floor(Math.random()*65),antenna:2,azimuth:0,wpm,homeWpm:13,keyMode:p.keyMode,
 iambicMode:'A',busy:false,keyDown:false,active:true,name:botNames[Math.floor(Math.random()*botNames.length)],
 qth:loc.qth,role:p.role,tone:p.tone,state:'LISTEN',lastAction:0,lastCQ:0,waitingUntil:0,partnerId:null,replyPending:false,history:[],bornAt:Date.now(),nextMoveAt:0,nextCQAt:Date.now()+2500+Math.random()*8000,cqCount:0};
}
const bots=new Map();
for(const b of VALID_BANDS)for(let i=0;i<personaStyles.length;i++){const st=makeBot(b,i);st.homeHz=st.hz;bots.set(st.stationId,st)}

for(const b of VALID_BANDS){
 const pool=[...bots.values()].filter(x=>x.band===b);
 pool.forEach((st,i)=>{
  st.active=i<4;
  st.bornAt=Date.now();
  st.nextMoveAt=Date.now()+270000+Math.random()*90000;
  st.nextCQAt=Date.now()+1800+i*2200+Math.random()*4500;
 });
}

const services=new Map([...VALID_BANDS].map(b=>[b,{stationId:`svc_${b}`,kind:'service',callsign:'CWN',locator:'',band:b,hz:SERVICE_FREQ[b],power:40,antenna:2,azimuth:0,wpm:18,keyMode:'PADDLE',iambicMode:'A',busy:false,keyDown:false,active:true}]));
const qsoSessions=new Map();
const pileups=new Map();

function humansOnBand(b){return [...clients.values()].filter(s=>s.band===b).length}
function activeBotsOnBand(b){return [...bots.values()].filter(x=>x.active&&x.band===b)}
function bandOccupiedNear(b,hz,span=220,exclude=''){return [...clients.values(),...bots.values()].some(s=>s.stationId!==exclude&&s.band===b&&s.keyDown&&Math.abs(s.hz-hz)<span)}
function setBotActive(st,on){
 if(st.active===on)return;st.active=on;st.keyDown=false;st.busy=false;st.partnerId=null;st.replyPending=false;st.state='LISTEN';pileups.delete(st.stationId);
 if(on){if(!st.hz)st.hz=st.homeHz||randomFreq(st.band);broadcast({type:'station_state',...publicState(st)})}
 else broadcast({type:'station_left',stationId:st.stationId});
}
function rebalanceBots(){
 for(const b of VALID_BANDS){
  const pool=[...bots.values()].filter(x=>x.band===b);
  const now=Date.now();

  // Stable population: four callers per band. This is above the requested
  // minimum of three, but avoids the rapid random churn of earlier versions.
  let active=pool.filter(x=>x.active);
  while(active.length<4){
   const candidates=pool.filter(x=>!x.active);
   if(!candidates.length)break;
   const st=candidates[Math.floor(Math.random()*candidates.length)];
   st.hz=randomFreeFreq(b,st.stationId);st.homeHz=st.hz;st.wpm=st.homeWpm=13;
   st.bornAt=now;st.cqCount=0;
   st.nextMoveAt=now+270000+Math.random()*90000; // 4.5-6 min on air
   st.nextCQAt=now+1500+Math.random()*6500;
   setBotActive(st,true);
   active.push(st);
  }

  // Rotate only after roughly five minutes, and never during an exchange.
  active=pool.filter(x=>x.active);
  const expired=active
   .filter(x=>!x.busy&&x.state==='LISTEN'&&now>(x.nextMoveAt||Infinity))
   .sort((a,c)=>(a.nextMoveAt||0)-(c.nextMoveAt||0));

  for(const old of expired){
   const replacement=pool.filter(x=>!x.active);
   if(!replacement.length){
    old.nextMoveAt=now+270000+Math.random()*90000;
    old.cqCount=0;
    continue;
   }
   setBotActive(old,false);
   pileups.delete(old.stationId);
   const st=replacement[Math.floor(Math.random()*replacement.length)];
   st.hz=randomFreeFreq(b,st.stationId);st.homeHz=st.hz;st.wpm=st.homeWpm=13;
   st.bornAt=now;st.cqCount=0;
   st.nextMoveAt=now+270000+Math.random()*90000;
   st.nextCQAt=now+1200+Math.random()*6000;
   setBotActive(st,true);
  }
 }
}
setInterval(rebalanceBots,9000);

function snapshotFor(ws){
 const stations=[...clients.values()].map(publicState).concat([...bots.values()].filter(b=>b.active).map(publicState),[...services.values()].map(publicState));
 send(ws,{type:'snapshot',stations});
}
function morseTimeline(text,wpm=18){
 const unit=1200/wpm,events=[];let t=0;const words=String(text).toUpperCase().trim().split(/\s+/);
 words.forEach((word,wi)=>{[...word].forEach((ch,ci)=>{const code=MORSE[ch];if(!code)return;[...code].forEach((el,ei)=>{const dur=el==='-'?3*unit:unit;events.push({at:t,down:true});t+=dur;events.push({at:t,down:false});if(ei<code.length-1)t+=unit});if(ci<word.length-1)t+=3*unit});if(wi<words.length-1)t+=7*unit});
 return {events,duration:t};
}
function transmitVirtual(st,text,{service=false,after=null}={}){
 if((!st.active&&!service)||st.busy)return false;
 text=safeText(text,180).replace(/\s+/g,' ').trim();if(!text)return false;
 st.busy=true;st.lastText=text;st.history=(st.history||[]).concat(text).slice(-6);
 const {events,duration}=morseTimeline(text,st.wpm),kind=service?'service':'human';

 // v0.32: virtual CW is delivered as one deterministic timeline.
 // The browser buffers it briefly and schedules every edge on the WebAudio clock.
 // Network/event-loop jitter can therefore no longer stretch dits and dahs.
 broadcastBand(st.band,{
  type:'cw_frame',stationId:st.stationId,kind,band:st.band,hz:st.hz,power:st.power,
  callsign:st.callsign,locator:st.locator,wpm:st.wpm,text,
  events:events.map(e=>[Math.round(e.at),e.down?1:0]),
  duration:Math.round(duration),seq:++serverSeq,t:Date.now()
 });

 // Keep objective server state for collision/activity logic, but do not stream
 // these individual edges over the WebSocket.
 events.forEach(ev=>setTimeout(()=>{
  st.keyDown=!!ev.down;
  if(ev.down)recordTx(st.band);
 },ev.at));
 if(service)broadcastBand(st.band,{type:'service_text',band:st.band,hz:st.hz,text});
 setTimeout(()=>{st.keyDown=false;st.busy=false;st.lastAction=Date.now();if(after)after()},duration+120);
 return true;
}
function fallbackReply(bot,other,stage='QSO'){
 const oc=other.callsign||'STN';
 if(stage==='CALL')return `${oc} DE ${bot.callsign} ${bot.callsign} K`;
 if(stage==='CLOSE')return `${oc} DE ${bot.callsign} TU FB QSO 73 SK`;
 const byRole={
  DX:[`${oc} DE ${bot.callsign} UR 599 599 TU BK`,`${oc} DE ${bot.callsign} R 5NN NAME ${bot.name} BK`],
  SKCC:[`${oc} DE ${bot.callsign} UR 579 NAME ${bot.name} QTH ${bot.qth} SKCC STYLE BK`,`${oc} DE ${bot.callsign} FB COPY NICE FIST NAME ${bot.name} BK`],
  POTA:[`${oc} DE ${bot.callsign} UR 579 POTA QTH ${bot.qth} BK`,`${oc} DE ${bot.callsign} R R TU POTA 599 BK`],
  SOTA:[`${oc} DE ${bot.callsign} UR 579 SOTA QTH ${bot.qth} BK`,`${oc} DE ${bot.callsign} R R TU SOTA 599 BK`],
  CQ:[`${oc} DE ${bot.callsign} UR 579 NAME ${bot.name} QTH ${bot.qth} BK`,`${oc} DE ${bot.callsign} R R FB SIG 589 BK`]
 };
 const options=byRole[bot.role]||byRole.CQ;
 return options[Math.floor(Math.random()*options.length)];
}
function cleanAIText(raw,bot,other){
 let s=String(raw||'').toUpperCase().replace(/[^A-Z0-9/ ?.-]/g,' ').replace(/\s+/g,' ').trim();
 const marker='ANSWER:';const i=s.lastIndexOf(marker);if(i>=0)s=s.slice(i+marker.length).trim();
 s=s.split(/\b(EXPLANATION|NOTE|USER|ASSISTANT|SYSTEM)\b/)[0].trim();
 if(s.length>150)s=s.slice(0,150).replace(/\s+\S*$/,'');
 if(!s.includes(bot.callsign))s=`${other.callsign||'STN'} DE ${bot.callsign} ${s}`;
 return s||fallbackReply(bot,other);
}
async function aiReply(bot,other,context,stage='QSO',source='human',session=null){
 const oc=other.callsign||'STN';
 const seed=fallbackReply(bot,other,stage);
 const hist=(session?.history||[]).slice(-8).map(x=>`${x.from}: ${x.text}`).join('\n')||'(no previous turns)';
 const operatorStyle={
  SKCC:'friendly traditional SKCC-style CW operator, patient and simple',
  POTA:'concise portable activator, efficient POTA-style exchange',
  SOTA:'concise summit activator, efficient SOTA-style exchange',
  CQ:'general friendly CW operator',
  DX:'concise DX style, efficient reports, little chatter'
 }[bot.role]||'realistic amateur CW operator';
 const prompt=`You are operating an amateur-radio CW station, not chatting in prose.
IDENTITY: call ${bot.callsign}; name ${bot.name}; QTH ${bot.qth}; locator ${bot.locator}; power ${bot.power}W; role ${bot.role}; style ${operatorStyle}.
OTHER STATION: call ${oc}; observed WPM ${other.wpm||15}.
CURRENT STAGE: ${stage}.
JUST HEARD: ${String(context||'').slice(-180)}
QSO MEMORY:
${hist}

Rules:
- Output ONLY the exact text you would transmit in CW, uppercase.
- Maximum 18 words. Authentic CW abbreviations are encouraged.
- Keep callsigns, your name, QTH and identity consistent.
- Understand CQ, DE, RST, NAME, QTH, PWR, WX, QRS, QRQ, AGN, QRZ, BK, K, KN, 73 and SK naturally.
- If asked QRS, acknowledge and keep the exchange simple.
- Do not explain, narrate or mention AI.
- Do not invent a different callsign.
- For CALL, identify with ${bot.callsign}.
- For CLOSE, naturally end with 73 and SK.
A safe fallback example is: ${seed}
TRANSMIT:`;
 try{
  const raw=await requestAI(prompt,{timeout:AI_TIMEOUT_MS,source,stage});
  const cleaned=raw?cleanAIText(raw,bot,other):'';
  if(!cleaned||cleaned.length<6||!cleaned.includes(bot.callsign)){aiStats.fallbacks++;return seed}
  aiLastFinal=cleaned;
  return cleaned;
 }catch(err){aiStats.fallbacks++;return seed}
}

function findHumanNear(bot,span=500){return [...clients.values()].find(s=>s.band===bot.band&&Math.abs(s.hz-bot.hz)<=span)}
function findBotNearCQ(bot){return activeBotsOnBand(bot.band).filter(x=>x.stationId!==bot.stationId&&!x.busy&&x.state==='WAIT_REPLY'&&Math.abs(x.hz-bot.hz)<=650)[0]||null}
async function startBotToBot(caller,hunter){
 if(!caller||!hunter||caller.busy||hunter.busy)return;
 hunter.hz=caller.hz;hunter.partnerId=caller.stationId;caller.partnerId=hunter.stationId;
 hunter.state='QSO';caller.state='QSO';broadcast({type:'station_state',...publicState(hunter)});
 const session={origin:'bot',stage:1,last:Date.now(),history:[]};
 if(caller.lastText)session.history.push({from:caller.callsign,text:caller.lastText});
 const humanPresent=humansOnBand(caller.band)>0;
 // External AI budget policy:
 // - no humans on this band: 0 Gemini calls for bot↔bot traffic
 // - humans listening on this band: roughly 25% of bot turns may use Gemini
 const getLine=async(bot,other,stage,heard,turn)=>{
  const useGemini=humanPresent && Math.random()<.25;
  if(useGemini){
   const t=await aiReply(bot,other,heard,stage,'bot',session);
   session.history.push({from:bot.callsign,text:t});return t;
  }
  const t=fallbackReply(bot,other,stage);session.history.push({from:bot.callsign,text:t});return t;
 };
 const line=await getLine(hunter,caller,'CALL',caller.lastText||'',1);
 transmitVirtual(hunter,line,{after:()=>setTimeout(async()=>{
  if(!caller.active||!hunter.active)return;
  const reply=await getLine(caller,hunter,'QSO',line,2);
  transmitVirtual(caller,reply,{after:()=>setTimeout(async()=>{
   const third=await getLine(hunter,caller,'QSO',reply,3);
   transmitVirtual(hunter,third,{after:()=>setTimeout(async()=>{
    const close=await getLine(caller,hunter,'CLOSE',third,4);
    transmitVirtual(caller,close,{after:()=>{
     caller.state=hunter.state='LISTEN';caller.partnerId=hunter.partnerId=null;hunter.hz=hunter.homeHz;
     broadcast({type:'station_state',...publicState(hunter)});
    }});
   },700+Math.random()*900)});
  },700+Math.random()*900)});
 },700+Math.random()*900)});
}
async function botCallCQ(st){
 if(st.busy)return;
 if(!frequencyFree(st.band,st.hz,st.stationId)){
  st.hz=randomFreeFreq(st.band,st.stationId);st.homeHz=st.hz;
  broadcast({type:'station_state',...publicState(st)});
 }
 st.wpm=st.homeWpm=13;
 st.state='CQ';st.lastCQ=Date.now();st.cqCount=(st.cqCount||0)+1;
 const text={
  SKCC:`CQ SKCC CQ SKCC DE ${st.callsign} ${st.callsign} K`,
  POTA:`CQ POTA CQ POTA DE ${st.callsign} ${st.callsign} K`,
  SOTA:`CQ SOTA CQ SOTA DE ${st.callsign} ${st.callsign} K`,
  DX:`CQ DX CQ DX DE ${st.callsign} ${st.callsign} K`,
  CQ:`CQ CQ CQ DE ${st.callsign} ${st.callsign} K`
 }[st.role]||`CQ CQ DE ${st.callsign} ${st.callsign} K`;
 transmitVirtual(st,text,{after:()=>{
  st.state='WAIT_REPLY';st.waitingUntil=Date.now()+18000;
  setTimeout(()=>{
   if(st.state==='WAIT_REPLY'&&Date.now()>=st.waitingUntil){
    st.state='LISTEN';st.wpm=st.homeWpm=13;
    st.nextCQAt=Date.now()+6500+Math.random()*9500;
   }
  },18500);
 }});
}
async function trafficDirector(){
 const now=Date.now();
 for(const b of VALID_BANDS){
  const active=activeBotsOnBand(b);
  for(const st of active){
   if(st.state==='WAIT_HUMAN'&&st.waitingUntil&&now>=st.waitingUntil){
    st.state='LISTEN';st.partnerId=null;st.wpm=st.homeWpm=13;
    clearBotSessions(st.stationId);pileups.delete(st.stationId);
    st.hz=st.homeHz||st.hz;
    st.nextCQAt=now+7000+Math.random()*9000;
    broadcast({type:'station_state',...publicState(st)});
   }
   if(st.busy||st.state!=='LISTEN')continue;
   if(now>=(st.nextMoveAt||Infinity))continue;
   if(now<(st.nextCQAt||0))continue;

   // Each virtual operator has its own cadence. They may overlap naturally as
   // long as they are on separate free frequencies.
   if(!frequencyFree(b,st.hz,st.stationId)){
    st.hz=randomFreeFreq(b,st.stationId);
    st.homeHz=st.hz;
    broadcast({type:'station_state',...publicState(st)});
   }

   botCallCQ(st);
   // 9-19 s until this station calls again after returning to LISTEN.
   st.nextCQAt=now+9000+Math.random()*10000;
  }
 }
}
setInterval(()=>trafficDirector().catch(()=>{}),1200);

function humanLabel(st){return safeText(st.callsign||'STN',16)||'STN'}
function observedHumanWpm(st){
 const d=st?.decoder;
 if(d){
  const unit=estimatedUnit(d,st);
  if(Number.isFinite(unit)&&unit>0)return clamp(Math.round(1200/unit),7,35);
 }
 return clamp(Math.round(Number(st?.wpm)||15),7,35);
}
function chooseBotFor(b,hz){
 const pool=activeBotsOnBand(b).filter(x=>!x.busy&&x.state!=='QSO');
 const rank=x=>x.state==='LISTEN'?0:(x.state==='WAIT_REPLY'?1:(x.state==='WAIT_HUMAN'?2:3));
 return pool.sort((a,c)=>(rank(a)-rank(c))||(Math.abs(a.hz-hz)-Math.abs(c.hz-hz)))[0]||null;
}
function sessionKey(userId,botId){return userId+'|'+botId}
function newQsoSession(origin='botCQ',seed=[]){return {stage:1,last:Date.now(),origin,requestedWpm:null,history:[...seed].slice(-10)}}
function sessionPush(sess,from,text){
 if(!sess||!text)return;
 sess.history=sess.history||[];sess.history.push({from,text:String(text).slice(0,180)});sess.history=sess.history.slice(-10);sess.last=Date.now();
}
async function scheduleBotReply(user,bot,stage,context,delay=650,{matchHumanSpeed=false,session=null,sessionKeyValue=null}={}){
 if(!bot||bot.busy||bot.replyPending)return;
 if(bot.partnerId&&bot.partnerId!==user.stationId)return;
 bot.replyPending=true;
 const normalWpm=bot.homeWpm||bot.wpm;
 let replyWpm=normalWpm;
 if(matchHumanSpeed)replyWpm=observedHumanWpm(user);
 if(session?.requestedWpm)replyWpm=session.requestedWpm;
 bot.partnerId=user.stationId;bot.state='QSO';bot.hz=user.hz;bot.wpm=clamp(Math.round(replyWpm),7,35);bot.waitingUntil=Date.now()+35000;
 broadcast({type:'station_state',...publicState(bot)});
 setTimeout(async()=>{
  if(!bot.active||bot.busy)return;
  const text=await aiReply(bot,user,context,stage,'human',session);
  sessionPush(session,bot.callsign,text);
  transmitVirtual(bot,text,{after:()=>{
   bot.wpm=normalWpm;
   if(stage==='CLOSE'){
    recordQsoStat('bot',user,bot,bot.band).then(dist=>{const ws=wsForStation(user.stationId);if(ws)send(ws,{type:'qso_complete',with:bot.callsign,kind:'bot',distanceKm:dist,t:Date.now()});});
    bot.state='LISTEN';bot.partnerId=null;bot.wpm=bot.homeWpm=13;
    bot.hz=bot.homeHz||bot.hz;
    bot.nextCQAt=Date.now()+8000+Math.random()*9000;
    if(sessionKeyValue)qsoSessions.delete(sessionKeyValue);
    broadcast({type:'station_state',...publicState(bot)});
   }else{
    bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+30000;
    broadcast({type:'station_state',...publicState(bot)});
   }
  }});
 },delay+Math.floor(Math.random()*450));
}
function clearBotSessions(botId){
 for(const key of [...qsoSessions.keys()])if(key.endsWith('|'+botId))qsoSessions.delete(key);
}
function callerScore(user,bot,clean){
 const df=Math.abs((user.hz||0)-(bot.hz||0));
 let score=Math.max(0,55-df/5);
 if(clean.includes(bot.callsign))score+=26;
 const uc=humanLabel(user);
 if(uc!=='STN'&&clean.includes(uc))score+=24;
 if(!clean.includes('?'))score+=6;
 score+=Math.min(12,Math.max(0,(Number(user.power)||10)/8));
 return score;
}
function startPileupResolution(bot){
 const p=pileups.get(bot.stationId);
 if(!p||p.timer)return;
 p.timer=setTimeout(()=>resolvePileup(bot.stationId),1800);
}
async function resolvePileup(botId){
 const bot=bots.get(botId),p=pileups.get(botId);
 pileups.delete(botId);
 if(!bot||!bot.active||bot.busy||bot.state!=='WAIT_REPLY'||!p?.candidates?.size)return;

 const list=[...p.candidates.values()].sort((a,b)=>b.score-a.score);
 const winner=list[0];
 const runner=list[1];

 // If two callers arrive essentially together at similar strength, behave like
 // a human operator hearing a pileup: ask QRZ? rather than inventing a winner.
 if(runner && Math.abs(winner.score-runner.score)<7){
  bot.state='CQ';
  transmitVirtual(bot,'QRZ? QRZ? DE '+bot.callsign+' K',{after:()=>{
   bot.state='WAIT_REPLY';bot.waitingUntil=Date.now()+16000;
  }});
  return;
 }

 // Lock the virtual operator to exactly one station before any AI/network delay.
 bot.partnerId=winner.user.stationId;
 bot.state='QSO';
 broadcast({type:'station_state',...publicState(bot)});
 return engageHumanWithBot(winner.user,bot,winner.text);
}
async function engageHumanWithBot(user,addressed,clean){
 const key=sessionKey(user.stationId,addressed.stationId);
 let sess=qsoSessions.get(key);
 if(!sess){
  const seed=addressed.lastText?[{from:addressed.callsign,text:addressed.lastText}]:[];
  sess=newQsoSession('botCQ',seed);qsoSessions.set(key,sess);
 }
 sessionPush(sess,humanLabel(user),clean);
 if(/\bQRS\b/.test(clean)){
  const observed=observedHumanWpm(user);
  sess.requestedWpm=clamp(Math.min(observed,11),7,11);
 }
 if(/\bQRQ\b/.test(clean)){
  const current=sess.requestedWpm||13;
  sess.requestedWpm=clamp(current+2,13,30);
 }
 if(/\b73\b|\bSK\b/.test(clean)){
  return scheduleBotReply(user,addressed,'CLOSE',clean,450,{matchHumanSpeed:false,session:sess,sessionKeyValue:key});
 }
 sess.stage++;
 return scheduleBotReply(user,addressed,'QSO',clean,500,{matchHumanSpeed:false,session:sess,sessionKeyValue:key});
}
function humanPairKey(a,b){return [a.stationId,b.stationId].sort().join('|')}
async function completeHumanQso(a,b){
 const key=humanPairKey(a,b),now=Date.now();if(humanQsoCompleted.get(key)&&now-humanQsoCompleted.get(key)<180000)return;
 humanQsoCompleted.set(key,now);humanQsoPairs.delete(key);const dist=await recordQsoStat('human',a,b,a.band);
 const wa=wsForStation(a.stationId),wb=wsForStation(b.stationId);
 if(wa)send(wa,{type:'qso_complete',with:b.callsign||'STN',kind:'human',distanceKm:dist,t:now});
 if(wb)send(wb,{type:'qso_complete',with:a.callsign||'STN',kind:'human',distanceKm:dist,t:now});
}
function trackHumanQsoText(user,clean){
 user.lastDecodedText=clean;user.lastDecodedAt=Date.now();
 for(const other of clients.values()){
  if(other.stationId===user.stationId||other.band!==user.band||Math.abs((other.hz||0)-(user.hz||0))>300)continue;
  const key=humanPairKey(user,other),existing=humanQsoPairs.get(key),explicit=!!(other.callsign&&clean.includes(other.callsign));
  if(!explicit&&!existing)continue;
  const p=existing||{started:Date.now(),last:Date.now(),stations:new Set(),messages:0};
  p.last=Date.now();p.messages++;p.stations.add(user.stationId);if(other.lastDecodedAt&&Date.now()-other.lastDecodedAt<90000)p.stations.add(other.stationId);humanQsoPairs.set(key,p);
  if(/\b73\b|\bSK\b/.test(clean)&&p.stations.size>=2&&p.messages>=2&&Date.now()-p.started>3000)completeHumanQso(user,other);
 }
}
async function processHumanText(user,text){
 const clean=String(text||'').replace(/\s+/g,' ').trim().toUpperCase();
 if(!clean)return;
 trackHumanQsoText(user,clean);
 if(/QRS/.test(clean))recordRequestStat(user,'QRS');
 if(/QRQ/.test(clean))recordRequestStat(user,'QRQ');

 const humanIsCallingCQ=/(^|\s)CQ(\s|$)/.test(clean);

 // First, continue an already locked QSO. Other callers are ignored until it ends.
 const partnered=[...bots.values()].find(b=>
  b.active&&b.band===user.band&&b.partnerId===user.stationId&&
  ['QSO','WAIT_HUMAN'].includes(b.state)
 );
 if(partnered)return engageHumanWithBot(user,partnered,clean);

 // Caller-only policy: generic human CQ never wakes a bot.
 if(humanIsCallingCQ)return;

 // A new answer is eligible only while that virtual operator is actually waiting
 // after its own CQ. Explicitly typing/copying a bot call cannot steal a busy QSO.
 let addressed=[...bots.values()].find(b=>
  b.active&&b.band===user.band&&b.state==='WAIT_REPLY'&&
  clean.includes(b.callsign)
 );
 if(!addressed){
  addressed=activeBotsOnBand(user.band).find(b=>
   b.state==='WAIT_REPLY'&&Math.abs(b.hz-user.hz)<=280
  );
 }
 if(!addressed)return;

 let p=pileups.get(addressed.stationId);
 if(!p){
  p={candidates:new Map(),timer:null,openedAt:Date.now()};
  pileups.set(addressed.stationId,p);
 }
 const score=callerScore(user,addressed,clean);
 const prev=p.candidates.get(user.stationId);
 if(!prev||score>prev.score)p.candidates.set(user.stationId,{user,text:clean,score,at:Date.now()});
 startPileupResolution(addressed);
}
// Adaptive straight-key decoder: estimates dit length from short marks instead of trusting only selected WPM.
function decoderState(st){if(!st.decoder)st.decoder={marks:'',text:'',downAt:0,lastUp:0,charTimer:null,phraseTimer:null,samples:[],unit:1200/Math.max(5,st.wpm||15),recentChars:'',cqSeen:false};return st.decoder}
function estimatedUnit(d,st){
 const base=1200/Math.max(5,st.wpm||15);
 const samples=d.samples.filter(x=>x>18&&x<base*5.5).slice(-24).sort((a,b)=>a-b);
 if(samples.length>=3){
  // The lower third is dominated by dits even with an imperfect straight-key fist.
  const n=Math.max(1,Math.ceil(samples.length*.38));
  const lower=samples.slice(0,n);
  const med=lower[Math.floor(lower.length/2)];
  return clamp(med,base*.45,base*1.85);
 }
 return d.unit||base;
}
function commitServerChar(st){
 const d=decoderState(st);if(!d.marks)return;
 const ch=MORSE_INV[d.marks]||'?';
 d.text+=ch;d.recentChars=(d.recentChars+ch).slice(-8);
 if(d.recentChars.includes('CQ'))d.cqSeen=true;
 d.marks='';
}
function schedulePhrase(st){
 const d=decoderState(st);clearTimeout(d.phraseTimer);const unit=estimatedUnit(d,st);
 d.phraseTimer=setTimeout(()=>{
  commitServerChar(st);
  let text=d.text.trim();
  const cqSeen=d.cqSeen;
  d.text='';d.recentChars='';d.cqSeen=false;
  // A straight key can make one character imperfect. If the raw decoded stream
  // clearly contained CQ, preserve that intent so a virtual operator answers.
  if(cqSeen&&!/\bCQ\b/.test(text))text='CQ '+text;
  if(text)processHumanText(st,text);
 },Math.max(650,unit*9.0));
}
function serverKeyDown(st,now){
 const d=decoderState(st),unit=estimatedUnit(d,st);clearTimeout(d.charTimer);clearTimeout(d.phraseTimer);
 if(d.lastUp){const gap=now-d.lastUp;if(gap>=unit*4.8){commitServerChar(st);if(d.text&&!d.text.endsWith(' '))d.text+=' '}else if(gap>=unit*2.0)commitServerChar(st)}
 d.downAt=now;
}
function serverKeyUp(st,now){
 const d=decoderState(st);if(!d.downAt)return;const dur=now-d.downAt;d.downAt=0;d.lastUp=now;d.samples.push(dur);if(d.samples.length>30)d.samples.shift();
 const unit=estimatedUnit(d,st);d.unit=unit;
 if(dur>=unit*.30&&dur<=unit*6.0)d.marks+=dur<unit*1.9?'.':'-';else d.marks+='?';
 clearTimeout(d.charTimer);d.charTimer=setTimeout(()=>commitServerChar(st),unit*2.25);schedulePhrase(st);
}

function adminAuthorized(req,urlObj,bodyToken=''){
 if(!ADMIN_TOKEN)return false;
 const header=String(req.headers['x-cwn-admin-token']||'');
 const query=String(urlObj?.searchParams?.get('token')||'');
 return header===ADMIN_TOKEN||query===ADMIN_TOKEN||String(bodyToken||'')===ADMIN_TOKEN;
}
function sendJson(res,status,obj){
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
 res.end(JSON.stringify(obj,null,2));
}
function adminConsoleHtml(){
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <title>CW Network · AI Console</title><style>
 body{font-family:system-ui;background:#0b0e11;color:#e9eef2;margin:0;padding:24px}main{max-width:980px;margin:auto}
 textarea,input,button{width:100%;box-sizing:border-box;background:#11171c;color:#e9eef2;border:1px solid #35414b;border-radius:9px;padding:10px;margin:6px 0}
 textarea{min-height:130px}button{cursor:pointer;background:#1d4d32}pre{white-space:pre-wrap;background:#070a0c;border:1px solid #2b343d;padding:14px;border-radius:10px;min-height:120px}
 .row{display:grid;grid-template-columns:1fr 170px;gap:8px}.muted{color:#94a0aa;font-size:13px}</style></head>
 <body><main><h2>CW Network · Gemini Console</h2><p class="muted">Protected test console. The admin token is sent only to your backend, never to Gemini.</p>
 <input id="token" type="password" placeholder="CWN_ADMIN_TOKEN">
 <textarea id="q">You are a CW radio operator. Reply only in uppercase CW style to: CQ CQ DE ZP5DXS ZP5DXS K</textarea>
 <div class="row"><button id="go">SEND TEST</button><button id="stats">REFRESH STATS</button></div>
 <pre id="out">Ready.</pre>
 <script>
 const out=document.getElementById('out'),tok=()=>document.getElementById('token').value;
 document.getElementById('go').onclick=async()=>{out.textContent='Calling Gemini...';try{const r=await fetch('/ai/test',{method:'POST',headers:{'content-type':'application/json','x-cwn-admin-token':tok()},body:JSON.stringify({prompt:document.getElementById('q').value})});out.textContent=JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
 document.getElementById('stats').onclick=async()=>{try{const r=await fetch('/ai/debug?full=1',{headers:{'x-cwn-admin-token':tok()}});out.textContent=JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}};
 </script></main></body></html>`;
}
const server=http.createServer(async(req,res)=>{
 const urlObj=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
 if(urlObj.pathname==='/stats'){sendJson(res,200,{ok:true,...statsCache});return;}
 if(urlObj.pathname==='/'||urlObj.pathname==='/health'){
  sendJson(res,200,{
   ok:true,service:'CW Network',version:'0.40',
   clients:clients.size,activeBots:[...bots.values()].filter(b=>b.active).length,
   ai:aiState,aiProvider:'google-gemini',aiBusy,aiQueue:aiQueue.length,aiReadyAt,
   aiError:aiLastError||null,model:aiActiveModel,configuredModel:AI_MODEL,keyConfigured:!!GEMINI_API_KEY,
   aiStats:{requests:aiStats.requests,success:aiStats.success,fallbacks:aiStats.fallbacks,rateLimited:aiStats.rateLimited,errors:aiStats.errors,inputTokens:aiStats.inputTokens,outputTokens:aiStats.outputTokens,totalTokens:aiStats.totalTokens,avgLatencyMs:aiStats.success?Math.round(aiStats.latencyMsTotal/aiStats.success):null},
   statsPersistent:STATS_DB_READY,startedAt:SERVER_STARTED_AT,memoryMB:Math.round(process.memoryUsage().rss/1024/1024),
   uptime:Math.round(process.uptime()),spaceWeather
  });return;
 }
 if(urlObj.pathname==='/ai/debug'){
  const full=urlObj.searchParams.get('full')==='1';
  const auth=adminAuthorized(req,urlObj);
  sendJson(res,200,aiDebugSnapshot(full,auth));return;
 }
 if(urlObj.pathname==='/ai/console'){
  if(!ADMIN_TOKEN){
   res.writeHead(503,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
   res.end('AI console disabled. Add CWN_ADMIN_TOKEN in Render.');return;
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end(adminConsoleHtml());return;
 }
 if(urlObj.pathname==='/ai/test'&&req.method==='POST'){
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>12000){req.destroy();return}}
  let body={};try{body=JSON.parse(raw||'{}')}catch{return sendJson(res,400,{ok:false,error:'Invalid JSON'})}
  if(!adminAuthorized(req,urlObj,body.token))return sendJson(res,401,{ok:false,error:'Unauthorized'});
  const prompt=String(body.prompt||'').trim().slice(0,4000);
  if(!prompt)return sendJson(res,400,{ok:false,error:'prompt required'});
  const before={input:aiStats.inputTokens,output:aiStats.outputTokens,total:aiStats.totalTokens};
  const started=Date.now();const text=await requestAI(prompt,{timeout:AI_TIMEOUT_MS,source:'manual',stage:'MANUAL'});
  return sendJson(res,text?200:503,{
   ok:!!text,state:aiState,provider:'google-gemini',model:aiActiveModel,
   latencyMs:Date.now()-started,
   usage:{inputTokens:aiStats.inputTokens-before.input,outputTokens:aiStats.outputTokens-before.output,totalTokens:aiStats.totalTokens-before.total},
   prompt,text,error:text?null:aiLastError||'No response'
  });
 }
 res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({server,maxPayload:16*1024});
wss.on('connection',(ws,req)=>{
 const stationId=id('u');
 const state={stationId,kind:'human',visitorId:'',countryCode:'',country:'',callsign:'',locator:'',band:40,hz:7035000,power:10,antenna:2,azimuth:0,wpm:15,keyMode:'STRAIGHT',iambicMode:'A',lastSeen:Date.now(),keyDown:false,rate:null,decoder:null,missedPongs:0};
 clients.set(ws,state);ws.isAlive=true;send(ws,{type:'welcome',stationId,serverTime:Date.now()});send(ws,spaceWeather);send(ws,{type:'stats',...statsCache});snapshotFor(ws);presence();rebalanceBots();countryForIp(clientIp(req)).then(c=>{state.countryCode=c.code;state.country=c.name;if(state.visitorId)touchVisitor(state,0)});
 ws.on('pong',()=>{ws.isAlive=true;state.missedPongs=0;state.lastSeen=Date.now()});
 ws.on('message',buf=>{
  state.lastSeen=Date.now();if(buf.length>16*1024)return ws.close(1009,'payload');
  let m;try{m=JSON.parse(buf.toString())}catch{return}if(!rateOK(state,m.type))return;const now=Date.now();
  if(m.type==='station_state'){const old=JSON.stringify(publicState(state)),next=sanitizeState(m,state);next.stationId=stationId;next.kind='human';Object.assign(state,next);if(state.visitorId)touchVisitor(state,0);if(old!==JSON.stringify(publicState(state)))broadcast({type:'station_state',...publicState(state)},ws);return}
  if(m.type==='stats_like'){if(m.visitorId&&!state.visitorId)state.visitorId=String(m.visitorId).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);recordLikeStat(state,!!m.liked);return}
  if(m.type==='key_down'){if(state.keyDown)return;state.keyDown=true;const [lo,hi]=BAND_LIMITS[state.band];state.hz=clamp(Math.round(Number(m.hz)||state.hz),lo,hi);serverKeyDown(state,now);recordTx(state.band);broadcastBand(state.band,{type:'key_down',stationId,kind:'human',band:state.band,hz:state.hz,power:state.power,callsign:state.callsign,locator:state.locator,seq:++serverSeq,t:now},ws);return}
  if(m.type==='key_up'){if(!state.keyDown)return;state.keyDown=false;serverKeyUp(state,now);broadcastBand(state.band,{type:'key_up',stationId,seq:++serverSeq,t:now},ws);return}
  if(m.type==='leave')ws.close(1000,'bye');
 });
 ws.on('close',()=>{if(state.keyDown)broadcastBand(state.band,{type:'key_up',stationId,seq:++serverSeq,t:Date.now()},ws);if(state.decoder){clearTimeout(state.decoder.charTimer);clearTimeout(state.decoder.phraseTimer)}clients.delete(ws);broadcast({type:'station_left',stationId});presence();rebalanceBots()});
});

function serviceCycle(){
 const hhmm=new Date().toISOString().slice(11,16).replace(':','');
 for(const [b,st] of services){if(st.busy)continue;transmitVirtual(st,`CWN DE CWN UTC ${hhmm} USERS ${clients.size} BAND ${b}M ACT ${activityLevel(b)} KP ${spaceWeather.kp??'NA'} SFI ${spaceWeather.sfi??'NA'} 73`,{service:true})}
}
setTimeout(serviceCycle,5000);setInterval(serviceCycle,60000);

async function refreshSpaceWeather(){
 try{
  const [kpRes,sfiRes]=await Promise.all([
   fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',{headers:{'user-agent':'CW-Network/0.24'}}),
   fetch('https://services.swpc.noaa.gov/products/summary/10cm-flux.json',{headers:{'user-agent':'CW-Network/0.24'}})
  ]);
  if(!kpRes.ok||!sfiRes.ok)throw new Error('NOAA HTTP');
  const kpData=await kpRes.json(),sfiData=await sfiRes.json();const kp=Number(kpData?.at(-1)?.Kp),sfi=Number(sfiData?.at(-1)?.flux);
  spaceWeather={type:'space_weather',kp:Number.isFinite(kp)?kp:null,sfi:Number.isFinite(sfi)?sfi:null,updated:new Date().toISOString(),source:'NOAA SWPC'};broadcast(spaceWeather);
 }catch(err){console.error('space weather:',err?.message||err)}
}
refreshSpaceWeather();setInterval(refreshSpaceWeather,15*60*1000);
setInterval(presence,5000);
setInterval(()=>{for(const state of clients.values())touchVisitor(state,30)},30000);
setInterval(refreshStatsCache,15000);setTimeout(refreshStatsCache,2200);
setInterval(()=>{
 for(const [ws,state] of clients){
  const stale=Date.now()-state.lastSeen>180000;
  if(stale||state.missedPongs>=3){try{ws.terminate()}catch{};continue}
  state.missedPongs=(state.missedPongs||0)+1;ws.isAlive=false;
  try{ws.ping()}catch{}
 }
},45000);
setInterval(()=>{const now=Date.now();for(const [k,v] of qsoSessions)if(now-v.last>5*60*1000)qsoSessions.delete(k);for(const [k,v] of humanQsoPairs)if(now-v.last>3*60*1000)humanQsoPairs.delete(k);for(const [k,t] of humanQsoCompleted)if(now-t>10*60*1000)humanQsoCompleted.delete(k)},60000);

process.on('unhandledRejection',err=>console.error('unhandled rejection:',err?.message||err));
process.on('uncaughtException',err=>console.error('uncaught exception:',err?.message||err));

server.listen(PORT,'0.0.0.0',()=>console.log(`CW Network v0.40 listening on ${PORT}`));

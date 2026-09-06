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
 return {...prev,callsign:safeText(m.callsign||prev.callsign||'',16),locator:safeText(m.locator||prev.locator||'',10),visitorId:String(m.visitorId||prev.visitorId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80),sessionId:String(m.sessionId||prev.sessionId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,96),band,
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
let statsCache={visits:0,unique_users:0,countries:0,usage_seconds:0,likes:0,qsos:0,qso_bot:0,qso_human:0,avg_wpm:0,qrs:0,qrq:0,max_distance_km:0,top_callsigns:[],persistent:STATS_DB_READY};
const countryCache=new Map(),humanQsoPairs=new Map(),humanQsoCompleted=new Map();

async function supabaseRpc(fn,body={}){
 if(!STATS_DB_READY)return null;
 const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`,{method:'POST',headers:{'content-type':'application/json','apikey':SUPABASE_SERVICE_ROLE_KEY,'authorization':`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`},body:JSON.stringify(body)});
 if(!r.ok)throw new Error(`Supabase ${fn} HTTP ${r.status}: ${(await r.text()).slice(0,240)}`);
 const txt=await r.text();try{return txt?JSON.parse(txt):null}catch{return txt}
}
async function refreshStatsCache(){
 if(!STATS_DB_READY){statsCache={...statsCache,persistent:false};broadcast({type:'stats',...statsCache});return;}
 try{const data=await supabaseRpc('cwn_get_stats',{});if(data&&typeof data==='object')statsCache={...statsCache,...data,persistent:true};broadcast({type:'stats',...statsCache});}
 catch(err){console.error('stats refresh:',err?.message||err)}
}
function clientIp(req){const x=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();return x||String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'')}
async function countryForIp(ip){
 if(!ip||ip==='127.0.0.1'||ip==='::1')return {code:'',name:''};if(countryCache.has(ip))return countryCache.get(ip);
 let out={code:'',name:''};try{const r=await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,country`,{headers:{'user-agent':'CW-Network/0.47'}});const j=await r.json();if(j?.success!==false)out={code:String(j?.country_code||'').slice(0,2),name:String(j?.country||'').slice(0,64)}}catch(_){}
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
async function startVisit(state){
 if(!state?.visitorId||!state?.sessionId||state.visitCounted||!STATS_DB_READY)return;
 state.visitCounted=true;
 try{
  await supabaseRpc('cwn_start_visit',{
   p_visitor_id:state.visitorId,p_session_id:state.sessionId,
   p_country_code:state.countryCode||'',p_country:state.country||'',
   p_callsign:state.callsign||'',p_locator:state.locator||''
  });
  await refreshStatsCache();
 }catch(err){
  state.visitCounted=false;
  console.error('start visit:',err?.message||err);
 }
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
  ok:true,service:'CW Network AI',version:'0.47',provider:'google-gemini',
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

const services=new Map([...VALID_BANDS].map(b=>[b,{stationId:`svc_${b}`,kind:'service',callsign:'CWN',locator:'',band:b,hz:SERVICE_FREQ[b],power:40,antenna:2,azimuth:0,wpm:13,keyMode:'PADDLE',iambicMode:'A',busy:false,keyDown:false,active:true}]));
const qsoSessions=new Map();
const pileups=new Map();
const clusterSpots=new Map();

function clusterRows(now=Date.now()){
 for(const [k,s] of clusterSpots)if(s.expiresAt&&s.expiresAt<=now)clusterSpots.delete(k);
 return [...clusterSpots.values()]
  .filter(s=>!s.expiresAt||s.expiresAt>now)
  .sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0))
  .map(({internalIds,...s})=>s);
}
function broadcastCluster(){broadcast({type:'cluster_update',spots:clusterRows()})}
function sendCluster(ws){send(ws,{type:'cluster_update',spots:clusterRows()})}
function setClusterSpot(key,spot,ttl=120000){
 const now=Date.now();
 clusterSpots.set(key,{
  key,call:safeText(spot.call||'STN',16)||'STN',
  with:safeText(spot.with||'',16),
  band:Number(spot.band)||40,hz:Math.round(Number(spot.hz)||0),
  wpm:clamp(Math.round(Number(spot.wpm)||13),5,45),
  status:safeText(spot.status||'CQ',12)||'CQ',
  detail:safeText(spot.detail||'',24),
  updatedAt:now,expiresAt:ttl?now+ttl:0,
  internalIds:Array.isArray(spot.internalIds)?spot.internalIds:[]
 });
 broadcastCluster();
}
function removeClusterSpot(key){if(clusterSpots.delete(key))broadcastCluster()}
function removeClusterForStation(stationId){
 let changed=false;
 for(const [k,s] of clusterSpots){
  if(k===`human:${stationId}`||(s.internalIds||[]).includes(stationId)){clusterSpots.delete(k);changed=true}
 }
 if(changed)broadcastCluster();
}
setInterval(()=>{const before=clusterSpots.size;clusterRows();if(clusterSpots.size!==before)broadcastCluster()},15000);

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
 sendCluster(ws);
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
 const {events,duration}=morseTimeline(text,st.wpm),kind=service?'service':(st.kind||'virtual');

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
function cleanAIText(raw,bot,other,stage='QSO'){
 let s=String(raw||'').toUpperCase().replace(/[^A-Z0-9/ ?.-]/g,' ').replace(/\s+/g,' ').trim();
 const marker='ANSWER:';const i=s.lastIndexOf(marker);if(i>=0)s=s.slice(i+marker.length).trim();
 s=s.split(/\b(EXPLANATION|NOTE|USER|ASSISTANT|SYSTEM)\b/)[0].trim();
 if(s.length>150)s=s.slice(0,150).replace(/\s+\S*$/,'');
 // Callsigns are required at contact establishment/close, but not on every over.
 if((stage==='CALL_ACK'||stage==='CLOSE')&&!s.includes(bot.callsign))s=`${other.callsign||'STN'} DE ${bot.callsign} ${s}`;
 return s||fallbackReply(bot,other,stage==='CALL_ACK'?'CALL':stage);
}
async function aiReply(bot,other,context,stage='QSO',source='human',session=null){
 const oc=other.callsign||'STN';
 const seed=stage==='CLOSE'?`${oc} DE ${bot.callsign} TU FB QSO 73 SK`:`${oc} R FB BK`;
 const hist=(session?.history||[]).slice(-10).map(x=>`${x.from}: ${x.text}`).join('\n')||'(no previous turns)';
 const operatorStyle={
  SKCC:'friendly traditional SKCC-style CW operator, patient and simple',
  POTA:'concise portable activator, efficient POTA-style exchange',
  SOTA:'concise summit activator, efficient SOTA-style exchange',
  CQ:'general friendly CW operator',
  DX:'concise DX style, efficient reports, little chatter'
 }[bot.role]||'realistic amateur CW operator';
 const phase=session?.phase||'EXCHANGE';
 const prompt=`You are actually operating an amateur-radio CW QSO. This is over-the-air turn-taking, not a text chat.
IDENTITY: call ${bot.callsign}; name ${bot.name}; QTH ${bot.qth}; locator ${bot.locator}; power ${bot.power}W; role ${bot.role}; style ${operatorStyle}.
OTHER STATION: call ${oc}; observed WPM ${observedHumanWpm(other)}.
QSO PHASE: ${phase}. CURRENT ACTION: ${stage}.
JUST HEARD: ${String(context||'').slice(-180)}
QSO MEMORY:
${hist}

Rules:
- Output ONLY the exact short text you would transmit in CW, uppercase.
- Prefer 5-14 words. Use authentic CW abbreviations.
- Stay with ${oc} until a real 73/SK close. Never abandon the QSO because a turn is odd, short or partly copied.
- React to the LAST thing heard. A short "AGN?" means repeat your previous over. "QRS" means slow down. "QRQ" means speed up.
- Do not demand a fixed script or a particular next field. Accept RST, NAME, QTH, PWR, WX, comments or simple acknowledgements in any natural order.
- Do not dump RST + NAME + QTH + PWR all at once. Add at most ONE new personal/QSO fact per over unless the other station explicitly asks for several.
- If the other station gives an RST, acknowledge it and normally give your report if not already done.
- If the other station gives NAME/QTH/PWR/WX, acknowledge what was heard and continue naturally.
- Use BK when clearly turning it back. K/KN are also valid. Do not close unless the other station closes or the exchange clearly reaches 73.
- Callsigns do NOT need to be repeated on every over. Use them naturally, especially at the beginning and end.
- Keep your identity absolutely consistent. Never invent a different callsign/name/QTH.
- Do not explain, narrate, mention AI, or output prose commentary.
Safe fallback: ${seed}
TRANSMIT:`;
 try{
  const raw=await requestAI(prompt,{timeout:source==='human'?Math.min(AI_TIMEOUT_MS,3600):AI_TIMEOUT_MS,source,stage});
  const cleaned=raw?cleanAIText(raw,bot,other,stage):'';
  if(!cleaned||cleaned.length<2){aiStats.fallbacks++;return seed}
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
 setClusterSpot(`bot:${st.stationId}`,{call:st.callsign,band:st.band,hz:st.hz,wpm:st.wpm,status:'CQ',detail:st.role,internalIds:[st.stationId]},70000);
 const text={
  SKCC:`CQ SKCC CQ SKCC DE ${st.callsign} ${st.callsign} K`,
  POTA:`CQ POTA CQ POTA DE ${st.callsign} ${st.callsign} K`,
  SOTA:`CQ SOTA CQ SOTA DE ${st.callsign} ${st.callsign} K`,
  DX:`CQ DX CQ DX DE ${st.callsign} ${st.callsign} K`,
  CQ:`CQ CQ CQ DE ${st.callsign} ${st.callsign} K`
 }[st.role]||`CQ CQ DE ${st.callsign} ${st.callsign} K`;
 transmitVirtual(st,text,{after:()=>{
  st.state='WAIT_REPLY';st.waitingUntil=Date.now()+22000;
  setClusterSpot(`bot:${st.stationId}`,{call:st.callsign,band:st.band,hz:st.hz,wpm:st.wpm,status:'CQ',detail:'WAITING REPLY',internalIds:[st.stationId]},80000);
  setTimeout(()=>{
   if(st.state==='WAIT_REPLY'&&Date.now()>=st.waitingUntil){
    st.state='LISTEN';st.wpm=st.homeWpm=13;
    st.nextCQAt=Date.now()+6500+Math.random()*9500;
   }
  },22500);
 }});
}
async function trafficDirector(){
 const now=Date.now();
 for(const b of VALID_BANDS){
  const active=activeBotsOnBand(b);
  for(const st of active){
   if(st.state==='WAIT_HUMAN'&&st.waitingUntil&&now>=st.waitingUntil){
    const partner=[...clients.values()].find(x=>x.stationId===st.partnerId);
    const sess=partner?botSessionFor(partner,st):null;
    if(partner&&partner.band===st.band&&(sess?.nudgeCount||0)<2){
     if(sess)sess.nudgeCount=(sess.nudgeCount||0)+1;
     st.state='QSO';st.wpm=sess?.requestedWpm||13;
     const ask=`${humanLabel(partner)} DE ${st.callsign} AGN? K`;
     transmitVirtual(st,ask,{after:()=>{
      st.state='WAIT_HUMAN';st.waitingUntil=Date.now()+150000;
      setClusterSpot(`bot:${st.stationId}`,{call:st.callsign,with:humanLabel(partner),band:st.band,hz:st.hz,wpm:st.wpm,status:'QSO',detail:'AGN?',internalIds:[st.stationId,partner.stationId]},10*60*1000);
      broadcast({type:'station_state',...publicState(st)});
     }});
     continue;
    }
    // Do not abandon a live QSO because of decoder silence. As long as the partner
    // is still connected on the same frequency neighborhood, keep the lock.
    if(partner&&partner.band===st.band&&Math.abs((partner.hz||0)-(st.hz||0))<=650){
     st.state='WAIT_HUMAN';st.waitingUntil=Date.now()+300000;
     setClusterSpot(`bot:${st.stationId}`,{call:st.callsign,with:humanLabel(partner),band:st.band,hz:st.hz,wpm:st.wpm,status:'QSO',detail:'WAITING',internalIds:[st.stationId,partner.stationId]},10*60*1000);
     broadcast({type:'station_state',...publicState(st)});
     continue;
    }
    st.state='LISTEN';st.partnerId=null;st.replyPending=false;st.wpm=st.homeWpm=13;
    clearBotSessions(st.stationId);pileups.delete(st.stationId);
    st.hz=st.homeHz||st.hz;
    st.nextCQAt=now+7000+Math.random()*9000;
    removeClusterSpot(`bot:${st.stationId}`);
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
function newQsoSession(origin='botCQ',seed=[]){
 const now=Date.now();
 return {stage:0,phase:'CALL_ACK',last:now,lastHeardAt:now,lastProcessedAt:0,rxSeq:0,handledRxSeq:0,
  turnTimer:null,origin,requestedWpm:null,nudgeCount:0,pendingTurns:[],history:[...seed].slice(-12),
  rstSent:false,nameSent:false,qthSent:false,pwrSent:false,turnsFromHuman:0,turnsFromBot:0};
}
function sessionPush(sess,from,text){
 if(!sess||!text)return;
 sess.history=sess.history||[];
 sess.history.push({from,text:String(text).slice(0,180)});
 sess.history=sess.history.slice(-12);sess.last=Date.now();
}
function clearSessionTurnTimer(sess){if(sess?.turnTimer){clearTimeout(sess.turnTimer);sess.turnTimer=null}}
function editDistance(a,b){
 a=String(a||'');b=String(b||'');
 const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
 for(let i=0;i<=a.length;i++)d[i][0]=i;for(let j=0;j<=b.length;j++)d[0][j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
 return d[a.length][b.length];
}
function fuzzyRepeatRequest(text){
 const s=String(text||'').toUpperCase().replace(/[^A-Z0-9? ]/g,' ').replace(/\s+/g,' ').trim();
 if(/\b(AGN|AGAIN|RPT|REPEAT|PSE AGN|AGN PSE)\b/.test(s))return true;
 const words=s.split(' ').filter(Boolean);
 return words.some(w=>{
  const x=w.replace(/\?/g,'');
  if(['AG','AN','GN'].includes(x))return true;
  if(x.length>=2&&x.length<=4&&editDistance(x,'AGN')<=1)return true;
  if(x.length>=2&&x.length<=4&&editDistance(x,'RPT')<=1)return true;
  return false;
 });
}
function decoderSnapshotText(st){
 const d=st?.decoder;if(!d)return '';
 let tail='';if(d.marks)tail=MORSE_INV[d.marks]||'?';
 return `${d.text||''}${tail}`.replace(/\s+/g,' ').trim().toUpperCase();
}
function previousBotOver(session,bot){
 return [...(session?.history||[])].reverse().find(x=>x.from===bot.callsign)?.text||bot.lastText||'';
}
function classifyHumanTurn(clean,session){
 const s=String(clean||'').toUpperCase().replace(/\s+/g,' ').trim();
 if(isQsoCloseText(s))return 'CLOSE';
 if(fuzzyRepeatRequest(s)||/\b(QRM|QSB)\b/.test(s))return 'REPEAT';
 if(/\bQRS\b/.test(s))return 'QRS';
 if(/\bQRQ\b/.test(s))return 'QRQ';
 if(session?.phase==='CALL_ACK')return 'CALL_ACK';
 return 'QSO';
}
function traceQso(event,user,bot,session,extra={}){
 try{console.log('[QSO]',event,JSON.stringify({user:humanLabel(user),bot:bot?.callsign||'',phase:session?.phase||'',state:bot?.state||'',busy:!!bot?.busy,pending:!!bot?.replyPending,...extra}))}catch(_){}
}
function armLockedTurnWatch(user,bot,sess){
 if(!user||!bot||!sess)return;
 clearSessionTurnTimer(sess);
 const seq=sess.rxSeq;
 sess.turnTimer=setTimeout(()=>{
  sess.turnTimer=null;
  if(!bot.active||bot.partnerId!==user.stationId)return;
  if(!wsForStation(user.stationId))return;
  if(sess.handledRxSeq>=seq)return;
  if(bot.busy||bot.replyPending){return armLockedTurnWatch(user,bot,sess)}
  const partial=decoderSnapshotText(user);
  sess.handledRxSeq=seq;sess.lastProcessedAt=Date.now();sess.lastHeardAt=Date.now();sess.last=Date.now();sess.nudgeCount=0;
  traceQso('WATCHDOG',user,bot,sess,{partial,seq});
  // Any RF activity in a locked QSO gets a response. If AGN-like, repeat exactly.
  if(fuzzyRepeatRequest(partial))return engageHumanWithBot(user,bot,'AGN');
  const msg=`${humanLabel(user)} DE ${bot.callsign} SRI NIL COPY AGN? BK`;
  sessionPush(sess,bot.callsign,msg);sess.turnsFromBot++;
  bot.replyPending=true;bot.state='QSO';bot.waitingUntil=Date.now()+300000;
  const sent=transmitVirtual(bot,msg,{after:()=>{
   bot.replyPending=false;bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+300000;
   setClusterSpot(`bot:${bot.stationId}`,{call:bot.callsign,with:humanLabel(user),band:bot.band,hz:bot.hz,wpm:bot.wpm,status:'QSO',detail:'AGN?',internalIds:[bot.stationId,user.stationId]},10*60*1000);
   broadcast({type:'station_state',...publicState(bot)});
  }});
  if(!sent){bot.replyPending=false;bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+300000}
 },3600);
}
function isQsoCloseText(text){
 const s=String(text||'').toUpperCase().replace(/\s+/g,' ').trim();
 if(!s)return false;
 if(/\b(SK|VA|CL)\b/.test(s))return true;
 if(!/\b73\b/.test(s))return false;
 const words=s.split(' '),i=words.indexOf('73');
 if(i===0||i>=words.length-4)return true;
 if(/\b(TU|TNX|TKS|QSO|CUL|GL|GB|HPE|ES)\b/.test(s))return true;
 return false;
}
function contextFallbackReply(bot,other,context,stage='QSO',session=null){
 const oc=other.callsign||'STN',s=String(context||'').toUpperCase();
 if(stage==='CALL_ACK')return `${oc} DE ${bot.callsign} R ${oc} UR 579 BK`;
 if(stage==='CLOSE')return `${oc} DE ${bot.callsign} TU FB QSO 73 SK`;
 if(stage==='REPEAT'||fuzzyRepeatRequest(s)||/\bQRM\b|\bQSB\b/.test(s)){
  const prev=previousBotOver(session,bot);
  return prev||`${oc} DE ${bot.callsign} AGN? BK`;
 }
 if(stage==='QRS'||/\bQRS\b/.test(s))return `${oc} DE ${bot.callsign} R QRS BK`;
 if(stage==='QRQ'||/\bQRQ\b/.test(s))return `${oc} DE ${bot.callsign} R QRQ BK`;
 if(/\bQTH\b/.test(s)&&/\?|\bQTH\?\b/.test(s))return `${oc} R QTH ${bot.qth} BK`;
 if(/\bNAME\b/.test(s)&&/\?|\bNAME\?\b/.test(s))return `${oc} R NAME ${bot.name} BK`;
 if(/\bPWR\b|\bPOWER\b/.test(s)&&/\?/.test(s))return `${oc} R PWR ${bot.power}W BK`;
 if(/\bRST\b|\bRPRT\b|\bREPORT\b/.test(s)&&/\?/.test(s))return `${oc} R UR 579 BK`;
 // Progressive fallback: one new item at a time, never a data dump.
 if(session&&!session.rstSent){session.rstSent=true;return `${oc} R TNX UR 579 BK`}
 if(session&&!session.nameSent){session.nameSent=true;return `${oc} R FB NAME ${bot.name} BK`}
 if(session&&!session.qthSent){session.qthSent=true;return `${oc} R QTH ${bot.qth} BK`}
 if(session&&!session.pwrSent){session.pwrSent=true;return `${oc} R PWR ${bot.power}W BK`}
 return `${oc} R FB TNX BK`;
}
function botSessionFor(user,bot){return qsoSessions.get(sessionKey(user.stationId,bot.stationId))}
function queuePendingTurn(session,context){
 if(!session)return;
 const t=String(context||'').trim();if(!t)return;
 session.pendingTurns=session.pendingTurns||[];
 const last=session.pendingTurns.at(-1);
 if(last!==t)session.pendingTurns.push(t);
 session.pendingTurns=session.pendingTurns.slice(-4);session.last=Date.now();
}
async function scheduleBotReply(user,bot,stage,context,delay=260,{matchHumanSpeed=false,session=null,sessionKeyValue=null}={}){
 if(!bot)return;
 if(bot.partnerId&&bot.partnerId!==user.stationId)return;
 if(bot.busy||bot.replyPending){
  queuePendingTurn(session,context);
  if(session){session.lastHeardAt=Date.now();session.last=Date.now()}
  bot.waitingUntil=Date.now()+300000;
  traceQso('QUEUE',user,bot,session,{stage,context:String(context||'').slice(0,80)});
  return;
 }
 bot.replyPending=true;
 const normalWpm=13;
 let replyWpm=matchHumanSpeed?observedHumanWpm(user):13;
 if(session?.requestedWpm)replyWpm=session.requestedWpm;
 bot.partnerId=user.stationId;bot.state='QSO';bot.hz=user.hz;bot.wpm=clamp(Math.round(replyWpm),7,35);bot.waitingUntil=Date.now()+300000;
 setClusterSpot(`bot:${bot.stationId}`,{call:bot.callsign,with:humanLabel(user),band:bot.band,hz:bot.hz,wpm:bot.wpm,status:'QSO',detail:'IN QSO',internalIds:[bot.stationId,user.stationId]},10*60*1000);
 broadcast({type:'station_state',...publicState(bot)});
 setTimeout(async()=>{
  if(!bot.active){bot.replyPending=false;return}
  if(bot.partnerId!==user.stationId){bot.replyPending=false;return}
  if(bot.busy){bot.replyPending=false;return scheduleBotReply(user,bot,stage,context,180,{matchHumanSpeed,session,sessionKeyValue})}
  let text='';
  try{
   const critical=['CALL_ACK','CLOSE','REPEAT','QRS','QRQ'].includes(stage);
   text=critical
    ? contextFallbackReply(bot,user,context,stage,session)
    : await aiReply(bot,user,context,stage,'human',session);
   if(!text)text=contextFallbackReply(bot,user,context,stage,session);
   sessionPush(session,bot.callsign,text);if(session)session.turnsFromBot=(session.turnsFromBot||0)+1;
   traceQso('TX',user,bot,session,{stage,text});
   const sent=transmitVirtual(bot,text,{after:()=>{
    bot.replyPending=false;
    if(stage==='CLOSE'){
     recordQsoStat('bot',user,bot,bot.band).then(dist=>{const ws=wsForStation(user.stationId);if(ws)send(ws,{type:'qso_complete',with:bot.callsign,kind:'bot',distanceKm:dist,t:Date.now()})});
     setClusterSpot(`bot:${bot.stationId}`,{call:bot.callsign,with:humanLabel(user),band:bot.band,hz:bot.hz,wpm:bot.wpm,status:'73',detail:'QSO COMPLETE',internalIds:[bot.stationId,user.stationId]},45000);
     bot.state='LISTEN';bot.partnerId=null;bot.wpm=bot.homeWpm=13;bot.hz=bot.homeHz||bot.hz;bot.nextCQAt=Date.now()+8000+Math.random()*9000;
     if(sessionKeyValue){clearSessionTurnTimer(session);qsoSessions.delete(sessionKeyValue)}
     broadcast({type:'station_state',...publicState(bot)});return;
    }
    if(session&&session.phase==='CALL_ACK')session.phase='EXCHANGE';
    bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+300000;bot.wpm=session?.requestedWpm||normalWpm;
    setClusterSpot(`bot:${bot.stationId}`,{call:bot.callsign,with:humanLabel(user),band:bot.band,hz:bot.hz,wpm:bot.wpm,status:'QSO',detail:'WAITING',internalIds:[bot.stationId,user.stationId]},10*60*1000);
    broadcast({type:'station_state',...publicState(bot)});
    const pending=session?.pendingTurns?.shift();
    if(pending)setTimeout(()=>engageHumanWithBot(user,bot,pending,{fromQueue:true}),120);
   }});
   if(!sent){bot.replyPending=false;bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+300000;broadcast({type:'station_state',...publicState(bot)})}
  }catch(err){
   console.error('[QSO] reply error:',err?.message||err);
   bot.replyPending=false;bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+300000;
   // Never go silent on an exception: transmit a short recovery over when possible.
   setTimeout(()=>{if(bot.active&&bot.partnerId===user.stationId&&!bot.busy&&!bot.replyPending)engageHumanWithBot(user,bot,'AGN')},120);
   broadcast({type:'station_state',...publicState(bot)});
  }
 },delay+Math.floor(Math.random()*120));
}
function clearBotSessions(botId){
 for(const key of [...qsoSessions.keys()])if(key.endsWith('|'+botId)){const sess=qsoSessions.get(key);clearSessionTurnTimer(sess);qsoSessions.delete(key)}
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
 p.timer=setTimeout(()=>resolvePileup(bot.stationId),1250);
}
async function resolvePileup(botId){
 const bot=bots.get(botId),p=pileups.get(botId);
 pileups.delete(botId);
 if(!bot||!bot.active||bot.busy||bot.state!=='WAIT_REPLY'||!p?.candidates?.size)return;
 const list=[...p.candidates.values()].sort((a,b)=>b.score-a.score),winner=list[0],runner=list[1];
 if(runner&&Math.abs(winner.score-runner.score)<7){
  bot.state='CQ';
  transmitVirtual(bot,'QRZ? QRZ? DE '+bot.callsign+' K',{after:()=>{bot.state='WAIT_REPLY';bot.waitingUntil=Date.now()+18000}});
  return;
 }
 bot.partnerId=winner.user.stationId;bot.state='QSO';
 setClusterSpot(`bot:${bot.stationId}`,{call:bot.callsign,with:humanLabel(winner.user),band:bot.band,hz:bot.hz,wpm:bot.wpm,status:'QSO',detail:'CONNECTED',internalIds:[bot.stationId,winner.user.stationId]},10*60*1000);
 broadcast({type:'station_state',...publicState(bot)});
 return engageHumanWithBot(winner.user,bot,winner.text);
}
async function engageHumanWithBot(user,addressed,clean,{fromQueue=false}={}){
 const key=sessionKey(user.stationId,addressed.stationId);
 let sess=qsoSessions.get(key),isNew=!sess;
 if(!sess){
  const seed=addressed.lastText?[{from:addressed.callsign,text:addressed.lastText}]:[];
  sess=newQsoSession('botCQ',seed);qsoSessions.set(key,sess);
 }
 const now=Date.now();sess.lastHeardAt=now;sess.lastProcessedAt=now;sess.handledRxSeq=sess.rxSeq;sess.nudgeCount=0;sess.last=now;clearSessionTurnTimer(sess);addressed.waitingUntil=now+300000;
 const normalized=String(clean||'').replace(/\s+/g,' ').trim().toUpperCase();
 if(!fromQueue)sessionPush(sess,humanLabel(user),normalized);
 sess.turnsFromHuman=(sess.turnsFromHuman||0)+1;
 setClusterSpot(`bot:${addressed.stationId}`,{call:addressed.callsign,with:humanLabel(user),band:addressed.band,hz:addressed.hz,wpm:addressed.wpm,status:'QSO',detail:'IN QSO',internalIds:[addressed.stationId,user.stationId]},10*60*1000);
 if(/\bQRS\b/.test(normalized)){const observed=observedHumanWpm(user);sess.requestedWpm=clamp(Math.min(observed,11),7,11)}
 if(/\bQRQ\b/.test(normalized)){const current=sess.requestedWpm||13;sess.requestedWpm=clamp(current+2,13,30)}
 const stage=isNew&&!isQsoCloseText(normalized)?'CALL_ACK':classifyHumanTurn(normalized,sess);
 traceQso('RX',user,addressed,sess,{stage,text:normalized});
 return scheduleBotReply(user,addressed,stage,normalized,stage==='CLOSE'?180:(stage==='CALL_ACK'?220:240),{matchHumanSpeed:false,session:sess,sessionKeyValue:key});
}

function humanPairKey(a,b){return [a.stationId,b.stationId].sort().join('|')}
async function completeHumanQso(a,b){
 const key=humanPairKey(a,b),now=Date.now();if(humanQsoCompleted.get(key)&&now-humanQsoCompleted.get(key)<180000)return;
 humanQsoCompleted.set(key,now);humanQsoPairs.delete(key);const dist=await recordQsoStat('human',a,b,a.band);
 setClusterSpot(`pair:${key}`,{call:humanLabel(a),with:humanLabel(b),band:a.band,hz:a.hz,wpm:observedHumanWpm(a),status:'73',detail:'QSO COMPLETE',internalIds:[a.stationId,b.stationId]},45000);
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
  setClusterSpot(`pair:${key}`,{call:humanLabel(user),with:humanLabel(other),band:user.band,hz:user.hz,wpm:observedHumanWpm(user),status:'QSO',detail:'ON AIR',internalIds:[user.stationId,other.stationId]},4*60*1000);
  if(isQsoCloseText(clean)&&p.stations.size>=2&&p.messages>=2&&Date.now()-p.started>3000)completeHumanQso(user,other);
 }
}
async function processHumanText(user,text){
 const clean=String(text||'').replace(/\s+/g,' ').trim().toUpperCase();
 if(!clean)return;
 trackHumanQsoText(user,clean);
 if(/\bQRS\b/.test(clean))recordRequestStat(user,'QRS');
 if(/\bQRQ\b/.test(clean))recordRequestStat(user,'QRQ');

 const humanIsCallingCQ=/(^|\s)CQ(\s|$)/.test(clean);
 if(humanIsCallingCQ&&humanLabel(user)!=='STN'){
  setClusterSpot(`human:${user.stationId}`,{call:humanLabel(user),band:user.band,hz:user.hz,wpm:observedHumanWpm(user),status:'CQ',detail:'CALLING',internalIds:[user.stationId]},90000);
 }

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
// v0.47 adaptive event decoder. Because the browser sends exact key edges,
// we decode relative ON/OFF timings directly instead of treating selected WPM as truth.
function median(arr){
 const a=[...arr].filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return NaN;
 const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function twoMeans(values){
 const v=values.filter(x=>Number.isFinite(x)&&x>12).slice(-40).sort((a,b)=>a-b);
 if(v.length<4)return null;
 let c1=v[Math.floor(v.length*.25)],c2=v[Math.floor(v.length*.75)];
 for(let n=0;n<8;n++){
  const a=[],b=[];for(const x of v)(Math.abs(x-c1)<=Math.abs(x-c2)?a:b).push(x);
  if(!a.length||!b.length)break;c1=a.reduce((q,x)=>q+x,0)/a.length;c2=b.reduce((q,x)=>q+x,0)/b.length;
 }
 if(c1>c2)[c1,c2]=[c2,c1];
 return {short:c1,long:c2,ratio:c2/Math.max(1,c1)};
}
function decoderState(st){
 if(!st.decoder)st.decoder={marks:'',text:'',downAt:0,lastUp:0,charTimer:null,phraseTimer:null,
  markSamples:[],gapSamples:[],unit:1200/Math.max(5,st.wpm||15),recentChars:'',cqSeen:false,
  lastIntent:'',lastCommittedAt:0,lastSpotAt:0};
 return st.decoder;
}
function estimatedUnit(d,st){
 const base=1200/Math.max(5,st.wpm||15);
 const marks=(d.markSamples||[]).filter(x=>x>18&&x<base*7).slice(-36);
 const km=twoMeans(marks);
 if(km&&km.ratio>=1.75){
  // When two mark populations exist, the short cluster is the dit population.
  d.unit=clamp(km.short,base*.38,base*2.15);return d.unit;
 }
 if(marks.length){
  // With only one population (e.g. many dahs), choose the interpretation closest
  // to the current adaptive estimate rather than blindly calling every mark a dit.
  const m=median(marks),prev=d.unit||base;
  const asDit=m,asDah=m/3;
  d.unit=clamp(Math.abs(asDit-prev)<=Math.abs(asDah-prev)?asDit:asDah,base*.38,base*2.15);
  return d.unit;
 }
 return d.unit||base;
}
function classifyMark(dur,d,st){
 const unit=estimatedUnit(d,st),km=twoMeans(d.markSamples||[]);
 if(km&&km.ratio>=1.75){
  const cut=Math.sqrt(km.short*km.long);return dur<cut?'.':'-';
 }
 // Relative Morse timing: dah is nominally 3 dits; midpoint is ~2 dits.
 return dur<unit*1.95?'.':'-';
}
function maybeSpotDecodedIntent(st){
 const d=decoderState(st),tail=(d.text||'').replace(/\s+/g,' ').trim().toUpperCase();
 const compact=tail.replace(/[^A-Z0-9?]/g,'');
 if((/\bCQ\b/.test(tail)||compact.endsWith('CQ')||d.cqSeen)&&humanLabel(st)!=='STN'){
  d.cqSeen=true;d.lastIntent='CQ';
  setClusterSpot(`human:${st.stationId}`,{call:humanLabel(st),band:st.band,hz:st.hz,wpm:observedHumanWpm(st),status:'CQ',detail:'CALLING',internalIds:[st.stationId]},90000);
 }
}
function commitServerChar(st){
 const d=decoderState(st);if(!d.marks)return '';
 const ch=MORSE_INV[d.marks]||'?';
 d.text+=ch;d.recentChars=(d.recentChars+ch).slice(-12);d.lastCommittedAt=Date.now();
 if(d.recentChars.includes('CQ'))d.cqSeen=true;
 d.marks='';maybeSpotDecodedIntent(st);return ch;
}
function finalizeHumanPhrase(st){
 const d=decoderState(st);commitServerChar(st);
 let text=(d.text||'').replace(/\s+/g,' ').trim().toUpperCase();
 const cqSeen=d.cqSeen;
 d.text='';d.recentChars='';d.cqSeen=false;d.lastIntent='';
 if(cqSeen&&!/\bCQ\b/.test(text))text='CQ '+text;
 if(text){console.log('[DECODER]',JSON.stringify({call:humanLabel(st),text,wpm:observedHumanWpm(st)}));processHumanText(st,text)}
}
function schedulePhrase(st){
 const d=decoderState(st);clearTimeout(d.phraseTimer);const unit=estimatedUnit(d,st);
 // 6.2 units is comfortably beyond a word gap but much faster than the old 9-unit
 // phrase delay. Clamp for very slow/fast fists.
 const delay=clamp(unit*6.2,520,1500);
 d.phraseTimer=setTimeout(()=>finalizeHumanPhrase(st),delay);
}
function provisionalTxSpot(st,now){
 if(humanLabel(st)==='STN')return;
 if(now-(st.lastTxSpotAt||0)<4500)return;
 st.lastTxSpotAt=now;
 setClusterSpot(`human:${st.stationId}`,{call:humanLabel(st),band:st.band,hz:st.hz,wpm:observedHumanWpm(st),status:'TX',detail:'ON AIR',internalIds:[st.stationId]},7000);
}
function registerRfAnswerFallback(user){
 if(user.rfAnswerTimer)clearTimeout(user.rfAnswerTimer);
 user.rfAnswerTimer=setTimeout(()=>{
  user.rfAnswerTimer=null;
  // A locked QSO has its own watchdog; this fallback exists only for the first reply to a bot CQ.
  const locked=[...bots.values()].find(b=>b.active&&b.partnerId===user.stationId&&['QSO','WAIT_HUMAN'].includes(b.state));
  if(locked)return;
  const d=decoderState(user),partial=decoderSnapshotText(user);
  if(d.cqSeen||/\bCQ\b/.test(partial))return;
  const bot=activeBotsOnBand(user.band)
   .filter(b=>b.state==='WAIT_REPLY'&&!b.busy&&Math.abs((b.hz||0)-(user.hz||0))<=420)
   .sort((a,b)=>Math.abs(a.hz-user.hz)-Math.abs(b.hz-user.hz))[0];
  if(!bot)return;
  const clean=(partial&&partial.length>=2?partial:humanLabel(user));
  let p=pileups.get(bot.stationId);if(!p){p={candidates:new Map(),timer:null,openedAt:Date.now()};pileups.set(bot.stationId,p)}
  const score=callerScore(user,bot,clean)+18;
  const prev=p.candidates.get(user.stationId);
  if(!prev||score>prev.score)p.candidates.set(user.stationId,{user,text:clean,score,at:Date.now(),rfFallback:true});
  console.log('[DECODER] RF_ANSWER_FALLBACK',JSON.stringify({user:humanLabel(user),bot:bot.callsign,hz:user.hz,partial:clean}));
  startPileupResolution(bot);
 },1100);
}
function serverKeyDown(st,now){
 if(st.rfAnswerTimer){clearTimeout(st.rfAnswerTimer);st.rfAnswerTimer=null}
 provisionalTxSpot(st,now);
 const locked=[...bots.values()].find(b=>b.active&&b.partnerId===st.stationId&&['QSO','WAIT_HUMAN'].includes(b.state));
 if(locked){
  locked.waitingUntil=now+300000;
  const sess=botSessionFor(st,locked);if(sess){sess.lastHeardAt=now;sess.last=now;sess.rxSeq=(sess.rxSeq||0)+1;sess.nudgeCount=0;clearSessionTurnTimer(sess)}
 }
 const d=decoderState(st),unit=estimatedUnit(d,st);clearTimeout(d.charTimer);clearTimeout(d.phraseTimer);
 if(d.lastUp){
  const gap=now-d.lastUp;d.gapSamples.push(gap);if(d.gapSamples.length>40)d.gapSamples.shift();
  // Nominal gaps: 1u element, 3u character, 7u word. Midpoints are ~2u and ~5u.
  if(gap>=unit*4.7){commitServerChar(st);if(d.text&&!d.text.endsWith(' '))d.text+=' ';maybeSpotDecodedIntent(st)}
  else if(gap>=unit*1.85)commitServerChar(st);
 }
 d.downAt=now;
}
function serverKeyUp(st,now){
 const d=decoderState(st);if(!d.downAt)return;const dur=now-d.downAt;d.downAt=0;d.lastUp=now;
 if(dur>=18&&dur<=2500){d.markSamples.push(dur);if(d.markSamples.length>40)d.markSamples.shift();d.marks+=classifyMark(dur,d,st)}else d.marks+='?';
 const unit=estimatedUnit(d,st);clearTimeout(d.charTimer);d.charTimer=setTimeout(()=>commitServerChar(st),clamp(unit*1.85,90,520));schedulePhrase(st);
 const locked=[...bots.values()].find(b=>b.active&&b.partnerId===st.stationId&&['QSO','WAIT_HUMAN'].includes(b.state));
 if(locked){const sess=botSessionFor(st,locked);if(sess)armLockedTurnWatch(st,locked,sess)}
 else registerRfAnswerFallback(st);
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
   ok:true,service:'CW Network',version:'0.47',
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
 const state={stationId,kind:'human',visitorId:'',sessionId:'',visitCounted:false,countryCode:'',country:'',callsign:'',locator:'',band:40,hz:7035000,power:10,antenna:2,azimuth:0,wpm:15,keyMode:'STRAIGHT',iambicMode:'A',lastSeen:Date.now(),keyDown:false,rate:null,decoder:null,rfAnswerTimer:null,lastTxSpotAt:0,missedPongs:0};
 clients.set(ws,state);ws.isAlive=true;send(ws,{type:'welcome',stationId,serverTime:Date.now()});send(ws,spaceWeather);send(ws,{type:'stats',...statsCache});snapshotFor(ws);presence();rebalanceBots();countryForIp(clientIp(req)).then(c=>{state.countryCode=c.code;state.country=c.name;if(state.visitorId){touchVisitor(state,0);startVisit(state)}});
 ws.on('pong',()=>{ws.isAlive=true;state.missedPongs=0;state.lastSeen=Date.now()});
 ws.on('message',buf=>{
  state.lastSeen=Date.now();if(buf.length>16*1024)return ws.close(1009,'payload');
  let m;try{m=JSON.parse(buf.toString())}catch{return}if(!rateOK(state,m.type))return;const now=Date.now();
  if(m.type==='station_state'){const old=JSON.stringify(publicState(state)),next=sanitizeState(m,state);next.stationId=stationId;next.kind='human';Object.assign(state,next);if(state.visitorId){startVisit(state);touchVisitor(state,0)}if(old!==JSON.stringify(publicState(state)))broadcast({type:'station_state',...publicState(state)},ws);return}
  if(m.type==='stats_like'){if(m.visitorId&&!state.visitorId)state.visitorId=String(m.visitorId).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);recordLikeStat(state,!!m.liked);return}
  if(m.type==='key_down'){if(state.keyDown)return;state.keyDown=true;const [lo,hi]=BAND_LIMITS[state.band];state.hz=clamp(Math.round(Number(m.hz)||state.hz),lo,hi);serverKeyDown(state,now);recordTx(state.band);broadcastBand(state.band,{type:'key_down',stationId,kind:'human',band:state.band,hz:state.hz,power:state.power,callsign:state.callsign,locator:state.locator,seq:++serverSeq,t:now},ws);return}
  if(m.type==='key_up'){if(!state.keyDown)return;state.keyDown=false;serverKeyUp(state,now);broadcastBand(state.band,{type:'key_up',stationId,seq:++serverSeq,t:now},ws);return}
  if(m.type==='leave')ws.close(1000,'bye');
 });
 ws.on('close',()=>{removeClusterForStation(stationId);if(state.keyDown)broadcastBand(state.band,{type:'key_up',stationId,seq:++serverSeq,t:Date.now()},ws);if(state.decoder){clearTimeout(state.decoder.charTimer);clearTimeout(state.decoder.phraseTimer)}if(state.rfAnswerTimer)clearTimeout(state.rfAnswerTimer);for(const bot of bots.values()){if(bot.partnerId===stationId){bot.partnerId=null;bot.replyPending=false;bot.state='LISTEN';bot.wpm=bot.homeWpm=13;bot.hz=bot.homeHz||bot.hz;bot.nextCQAt=Date.now()+5000+Math.random()*7000;clearBotSessions(bot.stationId);broadcast({type:'station_state',...publicState(bot)})}}clients.delete(ws);broadcast({type:'station_left',stationId});presence();rebalanceBots()});
});

function serviceCycle(){
 const hhmm=new Date().toISOString().slice(11,16).replace(':','');
 const useHours=(Number(statsCache.usage_seconds)||0)/3600;
 const useText=useHours<100?useHours.toFixed(1):String(Math.round(useHours));
 const dx=Math.round(Number(statsCache.max_distance_km)||0);
 const avg=Number(statsCache.avg_wpm)||0;
 const visits=Number(statsCache.visits)||0;
 const countries=Number(statsCache.countries)||0;
 const qsos=Number(statsCache.qsos)||0;
 for(const [b,st] of services){
  if(st.busy)continue;
  const msg=`CWN INFO UTC ${hhmm} VISITS ${visits} COUNTRIES ${countries} USE ${useText}H QSOS ${qsos} AVG ${avg.toFixed(1)} WPM DX ${dx}KM BAND ${b}M KP ${spaceWeather.kp??'NA'} SFI ${spaceWeather.sfi??'NA'} 73`;
  transmitVirtual(st,msg,{service:true});
 }
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
setInterval(async()=>{await Promise.all([...clients.values()].map(state=>touchVisitor(state,30)));await refreshStatsCache()},30000);
setInterval(refreshStatsCache,15000);setTimeout(refreshStatsCache,2200);
setInterval(()=>{
 for(const [ws,state] of clients){
  const stale=Date.now()-state.lastSeen>180000;
  if(stale||state.missedPongs>=3){try{ws.terminate()}catch{};continue}
  state.missedPongs=(state.missedPongs||0)+1;ws.isAlive=false;
  try{ws.ping()}catch{}
 }
},45000);
setInterval(()=>{const now=Date.now();for(const [k,v] of qsoSessions)if(now-v.last>15*60*1000){const [uid,bid]=k.split('|');const bot=bots.get(bid);if(!bot||bot.partnerId!==uid)qsoSessions.delete(k);}for(const [k,v] of humanQsoPairs)if(now-v.last>3*60*1000)humanQsoPairs.delete(k);for(const [k,t] of humanQsoCompleted)if(now-t>10*60*1000)humanQsoCompleted.delete(k)},60000);

process.on('unhandledRejection',err=>console.error('unhandled rejection:',err?.message||err));
process.on('uncaughtException',err=>console.error('uncaught exception:',err?.message||err));

server.listen(PORT,'0.0.0.0',()=>console.log(`CW Network v0.47 listening on ${PORT}`));

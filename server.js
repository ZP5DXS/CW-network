import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';

const PORT=Number(process.env.PORT||10000);
const VALID_BANDS=new Set([80,40,20,15,10]);
const BAND_LIMITS={80:[3550000,3560000],40:[7030000,7040000],20:[14025000,14035000],15:[21025000,21035000],10:[28020000,28030000]};
const SERVICE_FREQ={80:3551500,40:7031500,20:14026500,15:21026500,10:28021500};
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
function publicState(s){return {stationId:s.stationId,kind:s.kind,callsign:s.callsign,locator:s.locator,band:s.band,hz:s.hz,power:s.power,antenna:s.antenna,azimuth:s.azimuth,wpm:s.wpm,keyMode:s.keyMode,iambicMode:s.iambicMode,keyDown:!!s.keyDown}}
function recordTx(b){const now=Date.now(),a=recentBandTx.get(b)||[];a.push(now);while(a.length&&a[0]<now-120000)a.shift();recentBandTx.set(b,a)}
function activityLevel(b){const now=Date.now(),a=(recentBandTx.get(b)||[]).filter(t=>t>=now-120000);const n=[...clients.values()].filter(s=>s.band===b).length+[...bots.values()].filter(s=>s.active&&s.band===b).length;const score=a.length+n*2;return score>=45?'HIGH':score>=14?'MED':'LOW'}
function presence(){const activity={};for(const b of VALID_BANDS)activity[b]=activityLevel(b);broadcast({type:'presence',online:clients.size,activity})}
function sanitizeState(m,prev={}){
 const band=VALID_BANDS.has(+m.band)?+m.band:(prev.band||40),[lo,hi]=BAND_LIMITS[band];
 return {...prev,callsign:safeText(m.callsign||prev.callsign||'',16),locator:safeText(m.locator||prev.locator||'',10),band,
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
const AI_MODEL=process.env.CWN_AI_MODEL||'onnx-community/SmolLM2-135M-Instruct-ONNX';
const AI_DTYPE=process.env.CWN_AI_DTYPE||'q4f16';
const AI_ENABLED=process.env.CWN_AI_ENABLED!=='0';
const AI_DEBUG=process.env.CWN_AI_DEBUG==='1';
const AI_LOAD_TIMEOUT_MS=clamp(Number(process.env.CWN_AI_LOAD_TIMEOUT_MS)||120000,30000,300000);
const AI_MAX_RSS_MB=clamp(Number(process.env.CWN_AI_MAX_RSS_MB)||330,160,1024);
let aiState=AI_ENABLED?'STARTING':'DISABLED',aiWorker=null,aiBusy=false,aiReqSeq=0,aiLastError='',aiReadyAt=null;
let aiWorkerMemoryMB=null,aiWorkerHeapMB=null,aiWorkerStartedAt=null,aiWorkerLoadStartedAt=null,aiLoadProgress=null,aiLoadTimer=null;
const aiPending=new Map();
const aiQueue=[];
const aiStats={requests:0,humanRequests:0,botRequests:0,success:0,fallbacks:0,timeouts:0,busyFallbacks:0,workerExits:0,generationMsTotal:0,lastGenerationMs:null,lastRequestAt:null,lastSuccessAt:null};
const aiTrace=[];
let aiLastPrompt='',aiLastOutput='',aiLastSource='',aiLastStage='';
function traceAI(event,data={}){
 const row={at:new Date().toISOString(),event,...data};
 aiTrace.push(row);if(aiTrace.length>40)aiTrace.shift();
 console.log('[AI]',event,JSON.stringify(data));
}
function failAIPending(reason='AI unavailable'){
 for(const [rid,p] of aiPending){clearTimeout(p.timer);p.resolve(null)}
 aiPending.clear();
 while(aiQueue.length){const q=aiQueue.shift();q.resolve(null)}
 aiBusy=false;aiLastError=reason;
}
function stopAIWorker(reason='AI stopped'){
 clearTimeout(aiLoadTimer);aiLoadTimer=null;
 if(aiWorker){
  try{aiWorker.send({type:'shutdown',reason})}catch{}
  setTimeout(()=>{try{aiWorker?.kill('SIGTERM')}catch{}},250);
 }
}
function startAIWorker(){
 if(!AI_ENABLED||aiWorker)return;
 aiState='LOADING';aiLastError='';aiReadyAt=null;aiLoadProgress=null;aiWorkerLoadStartedAt=new Date().toISOString();
 try{
  aiWorker=fork(new URL('./ai-worker.js',import.meta.url),[],{
   stdio:['ignore','inherit','inherit','ipc'],
   env:{...process.env,CWN_AI_MODEL:AI_MODEL,CWN_AI_DTYPE:AI_DTYPE,CWN_AI_MAX_RSS_MB:String(AI_MAX_RSS_MB)}
  });
  aiWorkerStartedAt=new Date().toISOString();
  traceAI('worker-start',{pid:aiWorker.pid,model:AI_MODEL,dtype:AI_DTYPE,maxRssMB:AI_MAX_RSS_MB});
  aiLoadTimer=setTimeout(()=>{
   if(!['READY','DISABLED'].includes(aiState)){
    aiState='FALLBACK';aiLastError=`AI load timeout after ${AI_LOAD_TIMEOUT_MS} ms`;traceAI('load-timeout',{ms:AI_LOAD_TIMEOUT_MS});stopAIWorker(aiLastError);
   }
  },AI_LOAD_TIMEOUT_MS);
  aiWorker.on('message',m=>{
   if(!m||typeof m!=='object')return;
   if(m.type==='state'){
    aiState=m.state||aiState;
    if(m.error)aiLastError=String(m.error).slice(0,300);
    if(m.progress)aiLoadProgress=m.progress;
    if(aiState==='READY'){clearTimeout(aiLoadTimer);aiLoadTimer=null;aiReadyAt=new Date().toISOString();traceAI('ready',{pid:aiWorker?.pid,rssMB:aiWorkerMemoryMB})}
    else traceAI('state',{state:aiState,error:m.error||null});
    return;
   }
   if(m.type==='progress'){
    aiLoadProgress={status:m.status||null,file:m.file||null,progress:Number.isFinite(m.progress)?Math.round(m.progress*10)/10:null,loaded:m.loaded||null,total:m.total||null};
    return;
   }
   if(m.type==='memory'){
    aiWorkerMemoryMB=Number.isFinite(m.rssMB)?m.rssMB:aiWorkerMemoryMB;
    aiWorkerHeapMB=Number.isFinite(m.heapMB)?m.heapMB:aiWorkerHeapMB;
    return;
   }
   if(m.type==='result'){
    const p=aiPending.get(m.id);if(!p)return;
    clearTimeout(p.timer);aiPending.delete(m.id);aiBusy=false;
    const ms=Date.now()-p.startedAt;aiStats.lastGenerationMs=ms;aiStats.generationMsTotal+=ms;
    if(m.ok&&m.text){aiStats.success++;aiStats.lastSuccessAt=new Date().toISOString();aiLastOutput=String(m.text).slice(0,500);traceAI('generation-ok',{id:m.id,source:p.source,stage:p.stage,ms,chars:aiLastOutput.length})}
    else{aiStats.fallbacks++;if(m.error)aiLastError=String(m.error).slice(0,300);traceAI('generation-failed',{id:m.id,source:p.source,stage:p.stage,ms,error:m.error||null})}
    p.resolve(m.ok?m.text:null);pumpAIQueue();return;
   }
  });
  aiWorker.on('error',err=>{aiState='FALLBACK';failAIPending(err?.message||'AI worker error');traceAI('worker-error',{error:aiLastError})});
  aiWorker.on('exit',(code,signal)=>{
   clearTimeout(aiLoadTimer);aiLoadTimer=null;aiWorker=null;aiStats.workerExits++;
   if(aiState!=='DISABLED'&&aiState!=='FALLBACK')aiState='FALLBACK';
   if(!aiLastError)aiLastError=`AI worker exit ${code??''} ${signal??''}`.trim();
   failAIPending(aiLastError);traceAI('worker-exit',{code,signal,error:aiLastError});
  });
 }catch(err){aiState='FALLBACK';aiLastError=err?.message||String(err);traceAI('start-failed',{error:aiLastError})}
}
setTimeout(startAIWorker,5000);

function pumpAIQueue(){
 if(aiBusy||aiState!=='READY'||!aiWorker||!aiWorker.connected)return;
 const q=aiQueue.shift();if(!q)return;
 aiBusy=true;const rid=++aiReqSeq;q.startedAt=Date.now();
 const timer=setTimeout(()=>{
  aiPending.delete(rid);aiBusy=false;aiStats.timeouts++;aiStats.fallbacks++;aiLastError=`AI generation timeout (${q.timeout} ms)`;traceAI('generation-timeout',{id:rid,source:q.source,stage:q.stage,ms:q.timeout});q.resolve(null);pumpAIQueue();
 },q.timeout);
 aiPending.set(rid,{...q,timer});
 try{aiWorker.send({type:'generate',id:rid,prompt:q.prompt,source:q.source,stage:q.stage})}
 catch(err){clearTimeout(timer);aiPending.delete(rid);aiBusy=false;aiStats.fallbacks++;aiLastError=err?.message||String(err);q.resolve(null);pumpAIQueue()}
}
function requestAI(prompt,{timeout=7500,source='human',stage='QSO'}={}){
 aiStats.requests++;aiStats.lastRequestAt=new Date().toISOString();
 if(source==='human')aiStats.humanRequests++;else aiStats.botRequests++;
 aiLastPrompt=String(prompt||'').slice(0,1200);aiLastSource=source;aiLastStage=stage;
 if(aiState!=='READY'||!aiWorker||!aiWorker.connected){aiStats.fallbacks++;return Promise.resolve(null)}
 if(source!=='human'&&(aiBusy||aiQueue.length)){aiStats.busyFallbacks++;aiStats.fallbacks++;return Promise.resolve(null)}
 return new Promise(resolve=>{
  const item={prompt:String(prompt||''),timeout:clamp(Number(timeout)||7500,2500,12000),source,stage,resolve,startedAt:0};
  if(source==='human'){
   const firstBot=aiQueue.findIndex(x=>x.source!=='human');
   if(firstBot>=0)aiQueue.splice(firstBot,0,item);else aiQueue.push(item);
   while(aiQueue.length>3){const drop=aiQueue.pop();aiStats.busyFallbacks++;aiStats.fallbacks++;drop.resolve(null)}
  }else aiQueue.push(item);
  pumpAIQueue();
 });
}
function aiDebugSnapshot(full=false){
 const avg=aiStats.success?Math.round(aiStats.generationMsTotal/aiStats.success):null;
 const base={
  ok:true,service:'CW Network AI',version:'0.27',state:aiState,enabled:AI_ENABLED,busy:aiBusy,queue:aiQueue.map(x=>({source:x.source,stage:x.stage})),
  model:AI_MODEL,dtype:AI_DTYPE,readyAt:aiReadyAt,error:aiLastError||null,
  worker:{pid:aiWorker?.pid||null,startedAt:aiWorkerStartedAt,loadStartedAt:aiWorkerLoadStartedAt,rssMB:aiWorkerMemoryMB,heapMB:aiWorkerHeapMB,maxRssMB:AI_MAX_RSS_MB,loadTimeoutMs:AI_LOAD_TIMEOUT_MS,progress:aiLoadProgress},
  main:{rssMB:Math.round(process.memoryUsage().rss/1024/1024),heapMB:Math.round(process.memoryUsage().heapUsed/1024/1024),uptime:Math.round(process.uptime())},
  stats:{...aiStats,avgGenerationMs:avg},last:{source:aiLastSource||null,stage:aiLastStage||null,generationMs:aiStats.lastGenerationMs},trace:aiTrace.slice(-20)
 };
 if(full&&AI_DEBUG){base.last.prompt=aiLastPrompt||null;base.last.output=aiLastOutput||null;base.debugContent=true}else base.debugContent=false;
 return base;
}
const personaStyles=[
 {role:'SKCC',wpm:[11,16],keyMode:'STRAIGHT',tone:'friendly slow traditional CW operator'},
 {role:'BUG',wpm:[15,20],keyMode:'BUG',tone:'experienced conversational bug operator'},
 {role:'DX',wpm:[22,30],keyMode:'PADDLE',tone:'concise DX operator, short exchanges'},
 {role:'RAGCHEW',wpm:[16,22],keyMode:'PADDLE',tone:'warm ragchew operator, asks one short question'},
 {role:'HUNTER',wpm:[18,25],keyMode:'PADDLE',tone:'active hunter who answers CQs quickly'}
];
const botNames=['LEO','ANA','MATEO','LUIS','CARLOS','DIEGO','SAM','JEAN','MIKE','PAUL','KEN','AKI','ROB','JAN','TOM','ELI','NICO','MAX','IVAN','LUCA'];
const botQths=['ASUNCION','BUENOS AIRES','MONTEVIDEO','SAO PAULO','SANTIAGO','LIMA','BOGOTA','MIAMI','NEW YORK','MADRID','PARIS','LONDON','TOKYO','SYDNEY','AMSTERDAM'];
const locators=['GG14','GF05','GF15','GG66','FF46','FH17','FJ24','EL95','FN31','IN80','JN18','IO91','PM95','QF56','JO21'];
const callLetters='ABCDEFGHJKLMNPQRSTUVWXYZ';
const callSeen=new Set();
function virtualCall(b){
 let call;
 do{
  const a=callLetters[Math.floor(Math.random()*callLetters.length)];
  const c=callLetters[Math.floor(Math.random()*callLetters.length)];
  const d=Math.floor(Math.random()*9)+1;
  call=`CWN${String(b).slice(0,1)}${a}${d}${c}`;
 }while(callSeen.has(call));
 callSeen.add(call);return call;
}
function randomFreq(b){
 const [lo,hi]=BAND_LIMITS[b];let hz;
 do{hz=Math.round((lo+450+(Math.random()*(hi-lo-900)))/50)*50}while(Math.abs(hz-SERVICE_FREQ[b])<450);
 return hz;
}
function makeBot(b,index){
 const p=personaStyles[(index+Math.floor(Math.random()*personaStyles.length))%personaStyles.length];
 const wpm=Math.floor(p.wpm[0]+Math.random()*(p.wpm[1]-p.wpm[0]+1));
 return {stationId:id('v'),kind:'virtual',callsign:virtualCall(b),locator:locators[Math.floor(Math.random()*locators.length)],
 band:b,hz:randomFreq(b),homeHz:0,power:10+Math.floor(Math.random()*65),antenna:2,azimuth:0,wpm,keyMode:p.keyMode==='BUG'?'PADDLE':p.keyMode,
 iambicMode:p.keyMode==='BUG'?'BUG':'A',busy:false,keyDown:false,active:true,name:botNames[Math.floor(Math.random()*botNames.length)],
 qth:botQths[Math.floor(Math.random()*botQths.length)],role:p.role,tone:p.tone,state:'LISTEN',lastAction:0,lastCQ:0,waitingUntil:0,partnerId:null,history:[]};
}
const bots=new Map();
for(const b of VALID_BANDS)for(let i=0;i<4;i++){const st=makeBot(b,i);st.homeHz=st.hz;bots.set(st.stationId,st)}

const services=new Map([...VALID_BANDS].map(b=>[b,{stationId:`svc_${b}`,kind:'service',callsign:'CWN',locator:'',band:b,hz:SERVICE_FREQ[b],power:40,antenna:2,azimuth:0,wpm:18,keyMode:'PADDLE',iambicMode:'A',busy:false,keyDown:false,active:true}]));
const qsoSessions=new Map();

function humansOnBand(b){return [...clients.values()].filter(s=>s.band===b).length}
function activeBotsOnBand(b){return [...bots.values()].filter(x=>x.active&&x.band===b)}
function bandOccupiedNear(b,hz,span=220,exclude=''){return [...clients.values(),...bots.values()].some(s=>s.stationId!==exclude&&s.band===b&&s.keyDown&&Math.abs(s.hz-hz)<span)}
function setBotActive(st,on){
 if(st.active===on)return;st.active=on;st.keyDown=false;st.busy=false;st.partnerId=null;st.state='LISTEN';
 if(on){if(!st.hz)st.hz=st.homeHz||randomFreq(st.band);broadcast({type:'station_state',...publicState(st)})}
 else broadcast({type:'station_left',stationId:st.stationId});
}
function rebalanceBots(){
 for(const b of VALID_BANDS){
  const humans=humansOnBand(b);
  const target=humans===0?3:humans<=2?3:humans<=5?2:1;
  const pool=[...bots.values()].filter(x=>x.band===b),active=pool.filter(x=>x.active);
  if(active.length<target)pool.filter(x=>!x.active).slice(0,target-active.length).forEach(x=>setBotActive(x,true));
  if(active.length>target)active.filter(x=>!x.busy&&x.state==='LISTEN').slice(target).forEach(x=>setBotActive(x,false));
 }
}
setInterval(rebalanceBots,10000);

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
 events.forEach(ev=>setTimeout(()=>{if(ev.down){st.keyDown=true;recordTx(st.band);broadcastBand(st.band,{type:'key_down',stationId:st.stationId,kind,band:st.band,hz:st.hz,power:st.power,callsign:st.callsign,locator:st.locator,seq:++serverSeq,t:Date.now()})}else{st.keyDown=false;broadcastBand(st.band,{type:'key_up',stationId:st.stationId,seq:++serverSeq,t:Date.now()})}},ev.at));
 if(service)broadcastBand(st.band,{type:'service_text',band:st.band,hz:st.hz,text});
 setTimeout(()=>{st.busy=false;st.lastAction=Date.now();if(after)after()},duration+120);
 return true;
}
function fallbackReply(bot,other,stage='QSO'){
 const oc=other.callsign||'STN';
 if(stage==='CALL')return `${oc} DE ${bot.callsign} ${bot.callsign} K`;
 if(stage==='CLOSE')return `${oc} DE ${bot.callsign} TU FB QSO 73 SK`;
 const byRole={
  DX:[`${oc} DE ${bot.callsign} UR 599 599 TU BK`,`${oc} DE ${bot.callsign} R R 5NN NAME ${bot.name} BK`],
  SKCC:[`${oc} DE ${bot.callsign} GM UR 579 NAME ${bot.name} QTH ${bot.qth} HW BK`,`${oc} DE ${bot.callsign} FB COPY NICE FIST NAME ${bot.name} BK`],
  BUG:[`${oc} DE ${bot.callsign} R R FB COPY UR SIG 589 NAME ${bot.name} BK`,`${oc} DE ${bot.callsign} TNX CALL RUNNING ${bot.power}W HW BK`],
  RAGCHEW:[`${oc} DE ${bot.callsign} GM NAME ${bot.name} QTH ${bot.qth} WX FINE HR HW BK`,`${oc} DE ${bot.callsign} FB INFO NICE CW RUNNING ${bot.power}W VERTICAL HW BK`],
  HUNTER:[`${oc} DE ${bot.callsign} UR 579 NAME ${bot.name} QTH ${bot.qth} BK`,`${oc} DE ${bot.callsign} R R FB SIG 589 TNX CALL BK`]
 };
 const options=byRole[bot.role]||byRole.HUNTER;
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
async function aiReply(bot,other,context,stage='QSO',source='human'){
 const prompt=`CALL ${bot.callsign}; NAME ${bot.name}; QTH ${bot.qth}; ${bot.power}W; STYLE ${bot.role}.
HEARD ${String(context||'').slice(-180)}
STAGE ${stage}. Reply as realistic CW only, uppercase, <=16 words. No explanation. Use BK/K/73 SK correctly.
ANSWER:`;
 try{
  const raw=await requestAI(prompt,{timeout:7500,source,stage});
  return raw?cleanAIText(raw,bot,other):fallbackReply(bot,other,stage);
 }catch(err){return fallbackReply(bot,other,stage)}
}

function findHumanNear(bot,span=500){return [...clients.values()].find(s=>s.band===bot.band&&Math.abs(s.hz-bot.hz)<=span)}
function findBotNearCQ(bot){return activeBotsOnBand(bot.band).filter(x=>x.stationId!==bot.stationId&&!x.busy&&x.state==='WAIT_REPLY'&&Math.abs(x.hz-bot.hz)<=650)[0]||null}
async function startBotToBot(caller,hunter){
 if(!caller||!hunter||caller.busy||hunter.busy)return;
 hunter.hz=caller.hz;hunter.partnerId=caller.stationId;caller.partnerId=hunter.stationId;
 hunter.state='QSO';caller.state='QSO';broadcast({type:'station_state',...publicState(hunter)});
 const line=await aiReply(hunter,caller,caller.lastText||'', 'CALL','bot');
 transmitVirtual(hunter,line,{after:()=>setTimeout(async()=>{
  if(!caller.active||!hunter.active)return;
  const reply=fallbackReply(caller,hunter,'QSO');
  transmitVirtual(caller,reply,{after:()=>setTimeout(async()=>{
   const third=fallbackReply(hunter,caller,'QSO');
   transmitVirtual(hunter,third,{after:()=>setTimeout(async()=>{
    const close=fallbackReply(caller,hunter,'CLOSE');
    transmitVirtual(caller,close,{after:()=>{
     caller.state=hunter.state='LISTEN';caller.partnerId=hunter.partnerId=null;hunter.hz=hunter.homeHz;
     broadcast({type:'station_state',...publicState(hunter)});
    }});
   },700+Math.random()*900)});
  },700+Math.random()*900)});
 },700+Math.random()*900)});
}
async function botCallCQ(st){
 if(st.busy||bandOccupiedNear(st.band,st.hz,260,st.stationId))return;
 st.state='CQ';st.lastCQ=Date.now();
 const variants=[`CQ CQ DE ${st.callsign} ${st.callsign} K`,`CQ CQ CQ DE ${st.callsign} ${st.callsign} PSE K`,`CQ DE ${st.callsign} ${st.callsign} K`];
 transmitVirtual(st,variants[Math.floor(Math.random()*variants.length)],{after:()=>{
  st.state='WAIT_REPLY';st.waitingUntil=Date.now()+12000;
  setTimeout(()=>{if(st.state==='WAIT_REPLY'&&Date.now()>=st.waitingUntil)st.state='LISTEN'},12500);
 }});
}
async function trafficDirector(){
 for(const b of VALID_BANDS){
  const active=activeBotsOnBand(b).filter(x=>!x.busy);
  if(!active.length)continue;
  // Hunters answer any waiting CQ, creating audible bot-to-bot QSOs.
  const caller=active.find(x=>x.state==='WAIT_REPLY');
  if(caller){
   const hunter=active.find(x=>x.stationId!==caller.stationId&&x.state==='LISTEN'&&x.role!=='DX');
   if(hunter&&Math.random()<.42){startBotToBot(caller,hunter);continue}
  }
  // Keep quiet gaps, but make empty bands feel alive.
  const humans=humansOnBand(b);
  const recent=(recentBandTx.get(b)||[]).filter(t=>t>Date.now()-18000).length;
  if(recent<8){
   const candidate=active.find(x=>x.state==='LISTEN'&&Date.now()-x.lastAction>10000);
   if(candidate&&Math.random()<(humans<=1?.55:.30)){botCallCQ(candidate);continue}
  }
  // Hunters occasionally retune, mimicking band search.
  const hunter=active.find(x=>x.state==='LISTEN'&&x.role==='HUNTER'&&Date.now()-x.lastAction>12000);
  if(hunter&&Math.random()<.25){
   hunter.hz=randomFreq(b);hunter.homeHz=hunter.hz;hunter.lastAction=Date.now();broadcast({type:'station_state',...publicState(hunter)});
  }
 }
}
setInterval(()=>trafficDirector().catch(()=>{}),3500);

function humanLabel(st){return safeText(st.callsign||'STN',16)||'STN'}
function chooseBotFor(b,hz){return activeBotsOnBand(b).filter(x=>!x.busy&&x.state!=='QSO').sort((a,c)=>Math.abs(a.hz-hz)-Math.abs(c.hz-hz))[0]||null}
function sessionKey(userId,botId){return userId+'|'+botId}
async function scheduleBotReply(user,bot,stage,context,delay=650){
 if(!bot||bot.busy)return;
 bot.partnerId=user.stationId;bot.state='QSO';bot.hz=user.hz;broadcast({type:'station_state',...publicState(bot)});
 setTimeout(async()=>{
  if(!bot.active||bot.busy)return;
  const text=await aiReply(bot,user,context,stage,'human');
  transmitVirtual(bot,text,{after:()=>{
   if(stage==='CLOSE'){
    const ws=wsForStation(user.stationId);if(ws)send(ws,{type:'qso_complete',with:bot.callsign,t:Date.now()});
    bot.state='LISTEN';bot.partnerId=null;bot.hz=bot.homeHz;broadcast({type:'station_state',...publicState(bot)});
   }else{bot.state='WAIT_HUMAN';bot.waitingUntil=Date.now()+30000}
  }});
 },delay+Math.floor(Math.random()*650));
}
async function processHumanText(user,text){
 const clean=String(text||'').replace(/\s+/g,' ').trim().toUpperCase();if(!clean||clean.length<1)return;
 const userCall=humanLabel(user);
 // A bot that just called CQ will accept a nearby human reply even if its own callsign is omitted.
 let addressed=[...bots.values()].find(b=>b.active&&b.band===user.band&&clean.includes(b.callsign));
 if(!addressed){
  addressed=activeBotsOnBand(user.band).find(b=>['WAIT_REPLY','WAIT_HUMAN'].includes(b.state)&&Math.abs(b.hz-user.hz)<=650);
 }
 if(!addressed&&/\bCQ\b/.test(clean)){
  const bot=chooseBotFor(user.band,user.hz);if(!bot)return;
  qsoSessions.set(sessionKey(user.stationId,bot.stationId),{stage:1,last:Date.now()});
  return scheduleBotReply(user,bot,'CALL',clean,500);
 }
 if(!addressed)return;
 const key=sessionKey(user.stationId,addressed.stationId),sess=qsoSessions.get(key)||{stage:1,last:Date.now()};
 sess.last=Date.now();qsoSessions.set(key,sess);
 if(/\b73\b|\bSK\b/.test(clean)){qsoSessions.delete(key);return scheduleBotReply(user,addressed,'CLOSE',clean,450)}
 sess.stage++;return scheduleBotReply(user,addressed,'QSO',clean,500);
}

// Adaptive straight-key decoder: estimates dit length from short marks instead of trusting only selected WPM.
function decoderState(st){if(!st.decoder)st.decoder={marks:'',text:'',downAt:0,lastUp:0,charTimer:null,phraseTimer:null,samples:[],unit:1200/Math.max(5,st.wpm||15)};return st.decoder}
function estimatedUnit(d,st){
 const base=1200/Math.max(5,st.wpm||15);
 const shorts=d.samples.filter(x=>x>20&&x<base*2.2).slice(-14);
 if(shorts.length>=3){const sorted=[...shorts].sort((a,b)=>a-b);return clamp(sorted[Math.floor(sorted.length*.35)],base*.55,base*1.75)}
 return d.unit||base;
}
function commitServerChar(st){const d=decoderState(st);if(!d.marks)return;d.text+=MORSE_INV[d.marks]||'?';d.marks=''}
function schedulePhrase(st){const d=decoderState(st);clearTimeout(d.phraseTimer);const unit=estimatedUnit(d,st);d.phraseTimer=setTimeout(()=>{commitServerChar(st);const text=d.text.trim();d.text='';if(text)processHumanText(st,text)},unit*10.5)}
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

const server=http.createServer((req,res)=>{
 if(req.url==='/'||req.url==='/health'){
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({
   ok:true,service:'CW Network',version:'0.27',
   clients:clients.size,activeBots:[...bots.values()].filter(b=>b.active).length,
   ai:aiState,aiBusy,aiQueue:aiQueue.length,aiReadyAt,aiError:aiLastError||null,model:AI_MODEL,aiDtype:AI_DTYPE,
   aiPid:aiWorker?.pid||null,aiMemoryMB:aiWorkerMemoryMB,aiLoadProgress,startedAt:SERVER_STARTED_AT,
   memoryMB:Math.round(process.memoryUsage().rss/1024/1024),
   uptime:Math.round(process.uptime()),spaceWeather
  }));return;
 }
 if(req.url?.startsWith('/ai/debug')){
  const full=req.url.includes('full=1');
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(aiDebugSnapshot(full),null,2));return;
 }
 res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({server,maxPayload:16*1024});
wss.on('connection',(ws)=>{
 const stationId=id('u');
 const state={stationId,kind:'human',callsign:'',locator:'',band:40,hz:7035000,power:10,antenna:2,azimuth:0,wpm:15,keyMode:'STRAIGHT',iambicMode:'A',lastSeen:Date.now(),keyDown:false,rate:null,decoder:null,missedPongs:0};
 clients.set(ws,state);ws.isAlive=true;send(ws,{type:'welcome',stationId,serverTime:Date.now()});send(ws,spaceWeather);snapshotFor(ws);presence();rebalanceBots();
 ws.on('pong',()=>{ws.isAlive=true;state.missedPongs=0;state.lastSeen=Date.now()});
 ws.on('message',buf=>{
  state.lastSeen=Date.now();if(buf.length>16*1024)return ws.close(1009,'payload');
  let m;try{m=JSON.parse(buf.toString())}catch{return}if(!rateOK(state,m.type))return;const now=Date.now();
  if(m.type==='station_state'){const old=JSON.stringify(publicState(state)),next=sanitizeState(m,state);next.stationId=stationId;next.kind='human';Object.assign(state,next);if(old!==JSON.stringify(publicState(state)))broadcast({type:'station_state',...publicState(state)},ws);return}
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
setInterval(()=>{
 for(const [ws,state] of clients){
  const stale=Date.now()-state.lastSeen>180000;
  if(stale||state.missedPongs>=3){try{ws.terminate()}catch{};continue}
  state.missedPongs=(state.missedPongs||0)+1;ws.isAlive=false;
  try{ws.ping()}catch{}
 }
},45000);
setInterval(()=>{const now=Date.now();for(const [k,v] of qsoSessions)if(now-v.last>5*60*1000)qsoSessions.delete(k)},60000);

process.on('unhandledRejection',err=>console.error('unhandled rejection:',err?.message||err));
process.on('uncaughtException',err=>console.error('uncaught exception:',err?.message||err));

server.listen(PORT,'0.0.0.0',()=>console.log(`CW Network v0.27 listening on ${PORT}`));

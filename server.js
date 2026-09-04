import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 10000);
const VALID_BANDS = new Set([80,40,20,15,10]);
const BAND_LIMITS = {
  80:[3550000,3560000], 40:[7030000,7040000], 20:[14025000,14035000],
  15:[21025000,21035000], 10:[28020000,28030000]
};
const SERVICE_FREQ = {80:3551500,40:7031500,20:14026500,15:21026500,10:28021500};

const server=http.createServer((req,res)=>{
  if(req.url==='/health' || req.url==='/'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,service:'CW Network',clients:clients.size,uptime:Math.round(process.uptime())}));
    return;
  }
  res.writeHead(404); res.end('Not found');
});
const wss=new WebSocketServer({server,maxPayload:16*1024});
const clients=new Map();
const recentBandTx=new Map([...VALID_BANDS].map(b=>[b,[]]));
let serverSeq=0;

function id(prefix='st'){ return prefix+'_'+crypto.randomBytes(6).toString('hex'); }
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function safeText(v,n=16){ return String(v??'').replace(/[^A-Z0-9/\- ]/gi,'').toUpperCase().slice(0,n); }
function send(ws,obj){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj,except=null){
  const raw=JSON.stringify(obj);
  for(const [ws] of clients) if(ws!==except && ws.readyState===WebSocket.OPEN) ws.send(raw);
}
function sanitizeState(m,prev={}){
  const band=VALID_BANDS.has(+m.band)?+m.band:(prev.band||40);
  const [lo,hi]=BAND_LIMITS[band];
  return {
    stationId:prev.stationId, kind:prev.kind||'human',
    callsign:safeText(m.callsign||prev.callsign||'',16), locator:safeText(m.locator||prev.locator||'',10),
    band, hz:clamp(Math.round(Number(m.hz)||((lo+hi)/2)),lo,hi),
    power:clamp(Math.round(Number(m.power)||10),1,100), antenna:+m.antenna===1?1:2,
    azimuth:((Math.round(Number(m.azimuth)||0)%360)+360)%360,
    wpm:clamp(Math.round(Number(m.wpm)||15),5,45), keyMode:m.keyMode==='PADDLE'?'PADDLE':'STRAIGHT',
    iambicMode:['A','B','BUG'].includes(m.iambicMode)?m.iambicMode:'A'
  };
}
function publicState(s){ return {...s}; }
function recordTx(band){
  const now=Date.now(); const a=recentBandTx.get(band)||[]; a.push(now);
  while(a.length && a[0]<now-120000) a.shift(); recentBandTx.set(band,a);
}
function activityLevel(band){
  const now=Date.now(); const a=(recentBandTx.get(band)||[]).filter(t=>t>=now-120000);
  const stationCount=[...clients.values()].filter(s=>s.band===band).length + [...bots.values()].filter(s=>s.band===band).length;
  const score=a.length+stationCount*2;
  return score>=30?'HIGH':score>=10?'MED':'LOW';
}
function presence(){
  const activity={}; for(const b of VALID_BANDS) activity[b]=activityLevel(b);
  const msg={type:'presence',online:clients.size,activity};
  broadcast(msg);
}
function snapshotFor(ws){
  const stations=[...clients.values()].map(publicState).concat([...bots.values()].map(publicState));
  send(ws,{type:'snapshot',stations});
}

wss.on('connection',(ws,req)=>{
  const stationId=id('u');
  const state={stationId,kind:'human',callsign:'',locator:'',band:40,hz:7035000,power:10,antenna:2,azimuth:0,wpm:15,keyMode:'STRAIGHT',iambicMode:'A',lastSeen:Date.now(),lastMsgAt:0,keyDown:false};
  clients.set(ws,state);
  ws.isAlive=true;
  send(ws,{type:'welcome',stationId,serverTime:Date.now()}); snapshotFor(ws); presence();

  ws.on('pong',()=>{ws.isAlive=true; state.lastSeen=Date.now();});
  ws.on('message',buf=>{
    state.lastSeen=Date.now();
    if(buf.length>16*1024) return ws.close(1009,'payload');
    let m; try{m=JSON.parse(buf.toString());}catch{return;}
    const now=Date.now();
    if(now-state.lastMsgAt<2 && !['key_up','key_down'].includes(m.type)) return;
    state.lastMsgAt=now;

    if(m.type==='station_state'){
      const next=sanitizeState(m,state); next.stationId=stationId; next.kind='human'; next.lastSeen=now; next.lastMsgAt=state.lastMsgAt; next.keyDown=state.keyDown;
      const oldSig=JSON.stringify(publicState(state)); const newSig=JSON.stringify(publicState(next));
      Object.assign(state,next);
      if(oldSig!==newSig) broadcast({type:'station_state',...publicState(state)},ws);
      return;
    }
    if(m.type==='key_down'){
      if(state.keyDown) return;
      state.keyDown=true;
      const [lo,hi]=BAND_LIMITS[state.band]; state.hz=clamp(Math.round(Number(m.hz)||state.hz),lo,hi);
      recordTx(state.band);
      broadcast({type:'key_down',stationId,kind:'human',band:state.band,hz:state.hz,power:state.power,callsign:state.callsign,locator:state.locator,seq:++serverSeq,t:now},ws);
      return;
    }
    if(m.type==='key_up'){
      if(!state.keyDown) return;
      state.keyDown=false;
      broadcast({type:'key_up',stationId,seq:++serverSeq,t:now},ws); return;
    }
    if(m.type==='leave') ws.close(1000,'bye');
  });
  ws.on('close',()=>{
    if(state.keyDown) broadcast({type:'key_up',stationId,seq:++serverSeq,t:Date.now()},ws);
    clients.delete(ws); broadcast({type:'station_left',stationId}); presence();
  });
});

const MORSE={
 A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',
 '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','/':'-..-.','?':'..--..'
};
function morseTimeline(text,wpm=18){
  const unit=1200/wpm, events=[]; let t=0;
  const words=String(text).toUpperCase().trim().split(/\s+/);
  words.forEach((word,wi)=>{
    [...word].forEach((ch,ci)=>{
      const code=MORSE[ch]; if(!code) return;
      [...code].forEach((el,ei)=>{ const dur=el==='-'?3*unit:unit; events.push({at:t,down:true}); t+=dur; events.push({at:t,down:false}); if(ei<code.length-1)t+=unit; });
      if(ci<word.length-1)t+=3*unit;
    });
    if(wi<words.length-1)t+=7*unit;
  });
  return {events,duration:t};
}
function transmitVirtual(st,text,{service=false}={}){
  if(st.busy) return false; st.busy=true;
  const {events,duration}=morseTimeline(text,st.wpm);
  const kind=service?'service':'human';
  events.forEach(ev=>setTimeout(()=>{
    if(ev.down){ recordTx(st.band); broadcast({type:'key_down',stationId:st.stationId,kind,band:st.band,hz:st.hz,power:st.power,callsign:st.callsign,locator:st.locator,seq:++serverSeq,t:Date.now()}); }
    else broadcast({type:'key_up',stationId:st.stationId,seq:++serverSeq,t:Date.now()});
  },ev.at));
  if(service) broadcast({type:'service_text',band:st.band,hz:st.hz,text});
  setTimeout(()=>{st.busy=false;},duration+100);
  return true;
}

const bots=new Map();
const botSpecs=[
  ['CN1A',80,3554200,13,'STRAIGHT'],['CWN7A',40,7036200,16,'BUG'],['CWN2A',20,14029200,22,'PADDLE'],['CWN5A',15,21031400,20,'PADDLE'],['CWN0A',10,28024600,24,'PADDLE']
];
for(const [call,band,hz,wpm,keyMode] of botSpecs){
  const st={stationId:id('v'),kind:'virtual',callsign:call,locator:'',band,hz,power:25,antenna:2,azimuth:0,wpm,keyMode,iambicMode:'A',busy:false}; bots.set(st.stationId,st);
}
const services=new Map([...VALID_BANDS].map(b=>[b,{stationId:`svc_${b}`,kind:'service',callsign:'CWN',locator:'',band:b,hz:SERVICE_FREQ[b],power:40,antenna:2,azimuth:0,wpm:18,keyMode:'PADDLE',iambicMode:'A',busy:false}]));

function humansOnBand(b){ return [...clients.values()].filter(s=>s.band===b).length; }
function bandOccupiedNear(b,hz,span=180){
  return [...clients.values(),...bots.values()].some(s=>s.band===b && s.keyDown && Math.abs(s.hz-hz)<span);
}
function botCycle(){
  for(const st of bots.values()){
    if(st.busy) continue;
    const humans=humansOnBand(st.band);
    if(humans>=5 && Math.random()<.75) continue;
    if(bandOccupiedNear(st.band,st.hz)) continue;
    if(Math.random()<.18) transmitVirtual(st,`CQ CQ DE ${st.callsign} ${st.callsign} K`);
  }
}
setInterval(botCycle,7000);

function serviceCycle(){
  const hhmm=new Date().toISOString().slice(11,16).replace(':','');
  for(const [b,st] of services){
    if(st.busy) continue;
    const text=`CWN DE CWN UTC ${hhmm} USERS ${clients.size} BAND ${b}M ACT ${activityLevel(b)} 73`;
    transmitVirtual(st,text,{service:true});
  }
}
setTimeout(serviceCycle,5000); setInterval(serviceCycle,60000);

setInterval(presence,5000);
setInterval(()=>{
  for(const [ws,state] of clients){
    if(ws.isAlive===false || Date.now()-state.lastSeen>90000){ ws.terminate(); continue; }
    ws.isAlive=false; try{ws.ping();}catch{}
  }
},30000);

server.listen(PORT,'0.0.0.0',()=>console.log(`CW Network listening on ${PORT}`));

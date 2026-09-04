import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

const PORT=Number(process.env.PORT||10000);
const VALID_BANDS=new Set([80,40,20,15,10]);
const BAND_LIMITS={80:[3550000,3560000],40:[7030000,7040000],20:[14025000,14035000],15:[21025000,21035000],10:[28020000,28030000]};
const SERVICE_FREQ={80:3551500,40:7031500,20:14026500,15:21026500,10:28021500};
const clients=new Map(), recentBandTx=new Map([...VALID_BANDS].map(b=>[b,[]]));
let serverSeq=0;
let spaceWeather={type:'space_weather',kp:null,sfi:null,updated:null,source:'NOAA SWPC'};

const server=http.createServer((req,res)=>{
  if(req.url==='/'||req.url==='/health'){
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,service:'CW Network',clients:clients.size,activeBots:[...bots.values()].filter(b=>b.active).length,uptime:Math.round(process.uptime()),spaceWeather}));
    return;
  }
  res.writeHead(404); res.end('Not found');
});
const wss=new WebSocketServer({server,maxPayload:16*1024});

const MORSE={
 A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',
 '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','/':'-..-.','?':'..--..'
};
const MORSE_INV=Object.fromEntries(Object.entries(MORSE).map(([k,v])=>[v,k]));

function id(prefix='st'){return prefix+'_'+crypto.randomBytes(6).toString('hex')}
function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
function safeText(v,n=16){return String(v??'').replace(/[^A-Z0-9/\- ]/gi,'').toUpperCase().slice(0,n)}
function send(ws,obj){if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj))}
function broadcast(obj,except=null){const raw=JSON.stringify(obj);for(const [ws] of clients) if(ws!==except&&ws.readyState===WebSocket.OPEN) ws.send(raw)}
function wsForStation(stationId){for(const [ws,s] of clients) if(s.stationId===stationId)return ws;return null}
function publicState(s){return {stationId:s.stationId,kind:s.kind,callsign:s.callsign,locator:s.locator,band:s.band,hz:s.hz,power:s.power,antenna:s.antenna,azimuth:s.azimuth,wpm:s.wpm,keyMode:s.keyMode,iambicMode:s.iambicMode,keyDown:!!s.keyDown}}
function sanitizeState(m,prev={}){
  const band=VALID_BANDS.has(+m.band)?+m.band:(prev.band||40),[lo,hi]=BAND_LIMITS[band];
  return {...prev,callsign:safeText(m.callsign||prev.callsign||'',16),locator:safeText(m.locator||prev.locator||'',10),
    band,hz:clamp(Math.round(Number(m.hz)||((lo+hi)/2)),lo,hi),power:clamp(Math.round(Number(m.power)||10),1,100),
    antenna:+m.antenna===1?1:2,azimuth:((Math.round(Number(m.azimuth)||0)%360)+360)%360,
    wpm:clamp(Math.round(Number(m.wpm)||15),5,45),keyMode:m.keyMode==='PADDLE'?'PADDLE':'STRAIGHT',
    iambicMode:['A','B','BUG'].includes(m.iambicMode)?m.iambicMode:'A'};
}
function recordTx(b){const now=Date.now(),a=recentBandTx.get(b)||[];a.push(now);while(a.length&&a[0]<now-120000)a.shift();recentBandTx.set(b,a)}
function activityLevel(b){
  const now=Date.now(),a=(recentBandTx.get(b)||[]).filter(t=>t>=now-120000);
  const n=[...clients.values()].filter(s=>s.band===b).length+[...bots.values()].filter(s=>s.active&&s.band===b).length;
  const score=a.length+n*2; return score>=30?'HIGH':score>=10?'MED':'LOW';
}
function presence(){const activity={};for(const b of VALID_BANDS)activity[b]=activityLevel(b);broadcast({type:'presence',online:clients.size,activity})}
function snapshotFor(ws){
  const stations=[...clients.values()].map(publicState).concat([...bots.values()].filter(b=>b.active).map(publicState),[...services.values()].map(publicState));
  send(ws,{type:'snapshot',stations});
}
function rateOK(state,type){
  const now=Date.now();
  state.rate=state.rate||{t:now,key:0,msg:0};
  if(now-state.rate.t>=1000) state.rate={t:now,key:0,msg:0};
  if(type==='key_down'||type==='key_up'){state.rate.key++;return state.rate.key<=90}
  state.rate.msg++;return state.rate.msg<=35;
}

function morseTimeline(text,wpm=18){
  const unit=1200/wpm,events=[];let t=0;
  const words=String(text).toUpperCase().trim().split(/\s+/);
  words.forEach((word,wi)=>{
    [...word].forEach((ch,ci)=>{
      const code=MORSE[ch];if(!code)return;
      [...code].forEach((el,ei)=>{const dur=el==='-'?3*unit:unit;events.push({at:t,down:true});t+=dur;events.push({at:t,down:false});if(ei<code.length-1)t+=unit});
      if(ci<word.length-1)t+=3*unit;
    });
    if(wi<words.length-1)t+=7*unit;
  });
  return {events,duration:t};
}
function transmitVirtual(st,text,{service=false,after=null}={}){
  if(!st.active&&!service)return false;
  if(st.busy)return false;
  st.busy=true;st.lastText=text;
  const {events,duration}=morseTimeline(text,st.wpm),kind=service?'service':'human';
  events.forEach(ev=>setTimeout(()=>{
    if(ev.down){st.keyDown=true;recordTx(st.band);broadcast({type:'key_down',stationId:st.stationId,kind,band:st.band,hz:st.hz,power:st.power,callsign:st.callsign,locator:st.locator,seq:++serverSeq,t:Date.now()})}
    else{st.keyDown=false;broadcast({type:'key_up',stationId:st.stationId,seq:++serverSeq,t:Date.now()})}
  },ev.at));
  if(service) broadcast({type:'service_text',band:st.band,hz:st.hz,text});
  setTimeout(()=>{st.busy=false;if(after)after()},duration+120);
  return true;
}

const BOT_SPECS=[
 ['CWN8A',80,3554200,13,'STRAIGHT','IM63','MATEO','MONTEVIDEO'],
 ['CWN8B',80,3556900,15,'BUG','GF05','LUIS','BUENOS AIRES'],
 ['CWN8C',80,3558600,12,'STRAIGHT','GG66','ANA','SAO PAULO'],
 ['CWN7A',40,7036200,16,'BUG','GF05','LEO','BUENOS AIRES'],
 ['CWN7B',40,7033200,14,'STRAIGHT','GG66','CARLOS','SAO PAULO'],
 ['CWN7C',40,7038100,18,'PADDLE','FF46','DIEGO','SANTIAGO'],
 ['CWN2A',20,14029200,22,'PADDLE','FN31','SAM','NEW YORK'],
 ['CWN2B',20,14027100,20,'BUG','JN18','JEAN','PARIS'],
 ['CWN2C',20,14032700,24,'PADDLE','IO91','MIKE','LONDON'],
 ['CWN5A',15,21031400,20,'PADDLE','JN18','PAUL','PARIS'],
 ['CWN5B',15,21028600,23,'PADDLE','PM95','KEN','TOKYO'],
 ['CWN5C',15,21033300,18,'BUG','QF56','DAN','SYDNEY'],
 ['CWN0A',10,28024600,24,'PADDLE','PM95','AKI','TOKYO'],
 ['CWN0B',10,28027300,26,'PADDLE','QF56','ROB','SYDNEY'],
 ['CWN0C',10,28029200,22,'BUG','JO21','JAN','AMSTERDAM']
];
const bots=new Map();
for(const [call,band,hz,wpm,keyMode,locator,name,qth] of BOT_SPECS){
  const st={stationId:id('v'),kind:'virtual',callsign:call,locator,band,hz,homeHz:hz,power:25,antenna:2,azimuth:0,wpm,keyMode,iambicMode:'A',busy:false,keyDown:false,active:false,name,qth,lastCQ:0};
  bots.set(st.stationId,st);
}
const services=new Map([...VALID_BANDS].map(b=>[b,{stationId:`svc_${b}`,kind:'service',callsign:'CWN',locator:'',band:b,hz:SERVICE_FREQ[b],power:40,antenna:2,azimuth:0,wpm:18,keyMode:'PADDLE',iambicMode:'A',busy:false,keyDown:false,active:true}]));
const qsoSessions=new Map();

function humansOnBand(b){return [...clients.values()].filter(s=>s.band===b).length}
function activeBotsOnBand(b){return [...bots.values()].filter(x=>x.active&&x.band===b)}
function bandOccupiedNear(b,hz,span=180,excludeId=''){return [...clients.values(),...bots.values()].some(s=>s.stationId!==excludeId&&s.band===b&&s.keyDown&&Math.abs(s.hz-hz)<span)}
function setBotActive(st,on){
  if(st.active===on)return;
  st.active=on;st.keyDown=false;st.busy=false;st.hz=st.homeHz;
  if(on) broadcast({type:'station_state',...publicState(st)});
  else broadcast({type:'station_left',stationId:st.stationId});
}
function rebalanceBots(){
  for(const b of VALID_BANDS){
    const humans=humansOnBand(b);
    const target=humans===0?3:humans<=2?2:humans<=5?1:0;
    const pool=[...bots.values()].filter(x=>x.band===b),active=pool.filter(x=>x.active);
    if(active.length<target) pool.filter(x=>!x.active).slice(0,target-active.length).forEach(x=>setBotActive(x,true));
    if(active.length>target) active.filter(x=>!x.busy).slice(target).forEach(x=>setBotActive(x,false));
  }
}
rebalanceBots();setInterval(rebalanceBots,12000);

function chooseBotFor(b,hz){
  const cand=activeBotsOnBand(b).filter(x=>!x.busy&&(!x.reservedUntil||x.reservedUntil<Date.now()));
  if(!cand.length)return null;
  return cand.sort((a,c)=>Math.abs(a.hz-hz)-Math.abs(c.hz-hz))[0];
}
function sessionKey(userId,botId){return userId+'|'+botId}
function humanLabel(st){return safeText(st.callsign||'STN',16)||'STN'}
function scheduleBotReply(user,bot,text,delay=900,after=null){
  if(!bot||bot.busy)return;
  const wait=delay+Math.floor(Math.random()*500); bot.reservedUntil=Date.now()+wait+500;
  setTimeout(()=>{
    if(!bot.active||bot.busy)return;
    bot.hz=user.hz;bot.band=user.band;
    broadcast({type:'station_state',...publicState(bot)});
    transmitVirtual(bot,text,{after});
  },wait);
}
function processHumanText(user,text){
  const clean=String(text||'').replace(/\s+/g,' ').trim().toUpperCase();
  if(!clean||clean.length<2)return;
  const userCall=humanLabel(user);
  let addressed=[...bots.values()].find(b=>b.active&&b.band===user.band&&clean.includes(b.callsign));
  if(!addressed && /\bCQ\b/.test(clean)){
    const bot=chooseBotFor(user.band,user.hz); if(!bot)return;
    const key=sessionKey(user.stationId,bot.stationId);
    qsoSessions.set(key,{stage:1,last:Date.now()});
    scheduleBotReply(user,bot,`${userCall} DE ${bot.callsign} ${bot.callsign} K`,850);
    return;
  }
  if(!addressed)return;
  const key=sessionKey(user.stationId,addressed.stationId),sess=qsoSessions.get(key)||{stage:0,last:0};
  sess.last=Date.now();qsoSessions.set(key,sess);
  if(/\b73\b/.test(clean)||/\bSK\b/.test(clean)){
    sess.stage=4;
    scheduleBotReply(user,addressed,`${userCall} DE ${addressed.callsign} TU QSO 73 SK`,650,()=>{
      const ws=wsForStation(user.stationId); if(ws)send(ws,{type:'qso_complete',with:addressed.callsign,t:Date.now()});
      qsoSessions.delete(key); addressed.hz=addressed.homeHz;broadcast({type:'station_state',...publicState(addressed)});
    });
    return;
  }
  if(sess.stage<=1){
    sess.stage=2;
    scheduleBotReply(user,addressed,`${userCall} DE ${addressed.callsign} GM UR RST 579 NAME ${addressed.name} QTH ${addressed.qth} HW BK`,700);
  }else{
    sess.stage=3;
    const replies=[
      `${userCall} DE ${addressed.callsign} FB COPY TNX CALL UR SIG FB BK`,
      `${userCall} DE ${addressed.callsign} R R FB ${userCall} NICE CW HW BK`,
      `${userCall} DE ${addressed.callsign} TU INFO WX FINE HERE BK`
    ];
    scheduleBotReply(user,addressed,replies[Math.floor(Math.random()*replies.length)],650);
  }
}

function decoderState(st){
  if(!st.decoder)st.decoder={marks:'',text:'',downAt:0,lastUp:0,charTimer:null,phraseTimer:null};
  return st.decoder;
}
function commitServerChar(st){
  const d=decoderState(st);if(!d.marks)return;
  d.text+=MORSE_INV[d.marks]||'?';d.marks='';
}
function schedulePhrase(st){
  const d=decoderState(st);clearTimeout(d.phraseTimer);
  const unit=1200/Math.max(5,st.wpm||15);
  d.phraseTimer=setTimeout(()=>{commitServerChar(st);const text=d.text.trim();d.text='';if(text)processHumanText(st,text)},unit*11);
}
function serverKeyDown(st,now){
  const d=decoderState(st),unit=1200/Math.max(5,st.wpm||15);
  clearTimeout(d.charTimer);clearTimeout(d.phraseTimer);
  if(d.lastUp){
    const gap=now-d.lastUp;
    if(gap>=unit*5.2){commitServerChar(st);if(d.text&&!d.text.endsWith(' '))d.text+=' '}
    else if(gap>=unit*2.2)commitServerChar(st);
  }
  d.downAt=now;
}
function serverKeyUp(st,now){
  const d=decoderState(st),unit=1200/Math.max(5,st.wpm||15);
  if(!d.downAt)return;
  const dur=now-d.downAt;d.downAt=0;d.lastUp=now;
  if(dur>=unit*.35&&dur<=unit*5.5)d.marks+=dur<unit*2?'.':'-';else d.marks+='?';
  clearTimeout(d.charTimer);
  d.charTimer=setTimeout(()=>commitServerChar(st),unit*2.4);
  schedulePhrase(st);
}

wss.on('connection',(ws)=>{
  const stationId=id('u');
  const state={stationId,kind:'human',callsign:'',locator:'',band:40,hz:7035000,power:10,antenna:2,azimuth:0,wpm:15,keyMode:'STRAIGHT',iambicMode:'A',lastSeen:Date.now(),lastMsgAt:0,keyDown:false,rate:null,decoder:null};
  clients.set(ws,state);ws.isAlive=true;
  send(ws,{type:'welcome',stationId,serverTime:Date.now()});send(ws,spaceWeather);snapshotFor(ws);presence();rebalanceBots();

  ws.on('pong',()=>{ws.isAlive=true;state.lastSeen=Date.now()});
  ws.on('message',buf=>{
    state.lastSeen=Date.now();if(buf.length>16*1024)return ws.close(1009,'payload');
    let m;try{m=JSON.parse(buf.toString())}catch{return}
    if(!rateOK(state,m.type))return;
    const now=Date.now();
    if(m.type==='station_state'){
      const old=JSON.stringify(publicState(state)),next=sanitizeState(m,state);next.stationId=stationId;next.kind='human';
      Object.assign(state,next);const neu=JSON.stringify(publicState(state));
      if(old!==neu)broadcast({type:'station_state',...publicState(state)},ws);
      return;
    }
    if(m.type==='key_down'){
      if(state.keyDown)return;state.keyDown=true;
      const [lo,hi]=BAND_LIMITS[state.band];state.hz=clamp(Math.round(Number(m.hz)||state.hz),lo,hi);
      serverKeyDown(state,now);recordTx(state.band);
      broadcast({type:'key_down',stationId,kind:'human',band:state.band,hz:state.hz,power:state.power,callsign:state.callsign,locator:state.locator,seq:++serverSeq,t:now},ws);return;
    }
    if(m.type==='key_up'){
      if(!state.keyDown)return;state.keyDown=false;serverKeyUp(state,now);
      broadcast({type:'key_up',stationId,seq:++serverSeq,t:now},ws);return;
    }
    if(m.type==='leave')ws.close(1000,'bye');
  });
  ws.on('close',()=>{
    if(state.keyDown)broadcast({type:'key_up',stationId,seq:++serverSeq,t:Date.now()},ws);
    if(state.decoder){clearTimeout(state.decoder.charTimer);clearTimeout(state.decoder.phraseTimer)}
    clients.delete(ws);broadcast({type:'station_left',stationId});presence();rebalanceBots();
  });
});

function botCycle(){
  const now=Date.now();
  for(const st of bots.values()){
    if(!st.active||st.busy||(st.reservedUntil&&st.reservedUntil>now))continue;
    if(now-st.lastCQ<28000)continue;
    if(bandOccupiedNear(st.band,st.hz,220,st.stationId))continue;
    const humans=humansOnBand(st.band);
    const chance=humans===0?.10:humans<=2?.07:.035;
    if(Math.random()<chance){
      st.lastCQ=now;
      const texts=[
        `CQ CQ DE ${st.callsign} ${st.callsign} K`,
        `CQ CQ CQ DE ${st.callsign} ${st.callsign} PSE K`,
        `CQ DE ${st.callsign} ${st.callsign} K`
      ];
      transmitVirtual(st,texts[Math.floor(Math.random()*texts.length)]);
    }
  }
}
setInterval(botCycle,5000);

function serviceCycle(){
  const hhmm=new Date().toISOString().slice(11,16).replace(':','');
  for(const [b,st] of services){
    if(st.busy)continue;
    transmitVirtual(st,`CWN DE CWN UTC ${hhmm} USERS ${clients.size} BAND ${b}M ACT ${activityLevel(b)} KP ${spaceWeather.kp??'NA'} SFI ${spaceWeather.sfi??'NA'} 73`,{service:true});
  }
}
setTimeout(serviceCycle,5000);setInterval(serviceCycle,60000);

async function refreshSpaceWeather(){
  try{
    const [kpRes,sfiRes]=await Promise.all([
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',{headers:{'user-agent':'CW-Network/0.23'}}),
      fetch('https://services.swpc.noaa.gov/products/summary/10cm-flux.json',{headers:{'user-agent':'CW-Network/0.23'}})
    ]);
    if(!kpRes.ok||!sfiRes.ok)throw new Error('NOAA HTTP');
    const kpData=await kpRes.json(),sfiData=await sfiRes.json();
    const kpRow=kpData?.[kpData.length-1],sfiRow=sfiData?.[sfiData.length-1];
    const kp=Number(kpRow?.Kp),sfi=Number(sfiRow?.flux);
    spaceWeather={type:'space_weather',kp:Number.isFinite(kp)?kp:null,sfi:Number.isFinite(sfi)?sfi:null,updated:new Date().toISOString(),source:'NOAA SWPC'};
    broadcast(spaceWeather);
  }catch(err){console.error('space weather:',err.message)}
}
refreshSpaceWeather();setInterval(refreshSpaceWeather,15*60*1000);
setInterval(presence,5000);
setInterval(()=>{
  for(const [ws,state] of clients){
    if(ws.isAlive===false||Date.now()-state.lastSeen>90000){ws.terminate();continue}
    ws.isAlive=false;try{ws.ping()}catch{}
  }
},30000);
setInterval(()=>{
  const now=Date.now();for(const [k,v] of qsoSessions)if(now-v.last>5*60*1000)qsoSessions.delete(k);
},60000);

server.listen(PORT,'0.0.0.0',()=>console.log(`CW Network v0.23 listening on ${PORT}`));

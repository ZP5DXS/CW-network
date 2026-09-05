(() => {


  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const bands = {
    40:{base:7.030e6, center:7.035e6, min:7.030e6, max:7.040e6},
    20:{base:14.025e6,center:14.030e6,min:14.025e6,max:14.035e6},
    15:{base:21.025e6,center:21.030e6,min:21.025e6,max:21.035e6},
    10:{base:28.020e6,center:28.025e6,min:28.020e6,max:28.030e6}
  };
  let band = 40, hz = bands[40].center, tx=false, keyMode='STRAIGHT', antenna=2;
  let audioCtx, osc, gain;
  let lastKeyDown=0;
  let vfoStep=10, vfoFast=false, vfoTuneMode='NORMAL', scanTimer=null, scanHoldUntil=0;
  let selectedDigitPower=10;
  let rotorTarget=0, rotorActual=0, rotorTimer=null;
  let paddleDit=false, paddleDah=false;
  let dialDragging=false, dialLastAngle=0, dialDragAccum=0;
  let keyerLoopTimer=null, keyerElementActive=false;
  let manualDahDown=false, keyerGeneration=0, lastIambic='dah', iambicMode='A', squeezeWasActive=false, squeezeReleasePending=false;
  let sessionStarted=Date.now(), txAccumMs=0, txStartMs=0, qsoCount=0;
  const bandsUsed=new Set([40]);
  let liked=localStorage.getItem('cwNetLiked')==='1';
  let likeCount=Number(localStorage.getItem('cwNetLikeCount')||0);
  const SERVICE_CALL='CWN';
  const serviceFreqByBand={40:7031500,20:14026500,15:21026500,10:28021500};
  const npcTemplates=[
    {call:'K1VRT',role:'DX',wpm:24,style:'PADDLE',offset:2100},
    {call:'LU7NPC',role:'SKCC',wpm:14,style:'STRAIGHT',offset:-900},
    {call:'PY2BOT',role:'POTA',wpm:18,style:'PADDLE',offset:3300},
    {call:'EA4VRT',role:'RAGCHEW',wpm:16,style:'BUG',offset:-2400},
    {call:'JA1NPC',role:'DX',wpm:28,style:'PADDLE',offset:4100},
    {call:'W1CW',role:'MENTOR',wpm:12,style:'STRAIGHT',offset:900},
    {call:'G3VRT',role:'CQ',wpm:20,style:'BUG',offset:-3500},
    {call:'VK2NPC',role:'DX',wpm:22,style:'PADDLE',offset:4700}
  ];
  const activeTraces=new Map();
  let npcTimers=[];

  // -------- Realtime network / RF engine --------
  const WS_URL = document.querySelector('meta[name="cw-ws-url"]')?.content || 'wss://cw-network.onrender.com';
  let ws=null, reconnectTimer=null, stationId=null, netSeq=0, lastStateSent='', reconnectAttempts=0, socketGeneration=0;
  let stateSendTimer=null, connectedOnce=false;
  const remoteStations=new Map();
  const remoteVoices=new Map();
  let rxMaster=null, rxGate=null, noiseGain=null, noiseSource=null, noiseBandpass=null;
  let meterTimer=null, qrnTimer=null, qrnBuffer=null;
  let audioUnlocked=false;
  let rxReturnTimer=null,rxHoldActive=false;
  const directHeld=new Set();
  const decoderStates=new Map();
  const MORSE_DECODE={
    '.-':'A','-...':'B','-.-.':'C','-..':'D','.':'E','..-.':'F','--.':'G','....':'H','..':'I',
    '.---':'J','-.-':'K','.-..':'L','--':'M','-.':'N','---':'O','.--.':'P','--.-':'Q','.-.':'R',
    '...':'S','-':'T','..-':'U','...-':'V','.--':'W','-..-':'X','-.--':'Y','--..':'Z',
    '-----':'0','.----':'1','..---':'2','...--':'3','....-':'4','.....':'5','-....':'6',
    '--...':'7','---..':'8','----.':'9','-..-.':'/','..--..':'?'
  };
  let decodedText='';
  let spaceWeather={kp:null,sfi:null,updated:null,source:'NOAA SWPC'};

  function syncActivityPanelHeight(){
    const panel=$('.activityPanel');
    const main=$('main.main');
    if(!panel || !main) return;

    if(window.innerWidth<=980){
      panel.style.height='';
      panel.style.maxHeight='';
      return;
    }

    const panelTop=panel.getBoundingClientRect().top;
    const mainBottom=main.getBoundingClientRect().bottom;
    const available=Math.max(220,Math.floor(mainBottom-panelTop));
    panel.style.height=available+'px';
    panel.style.maxHeight=available+'px';
  }

  function utc(){
    $('#utc').textContent = new Date().toISOString().slice(11,19);
  }
  setInterval(utc,1000); utc();

  function freqParts(v){
    const s=(v/1e6).toFixed(6);
    const [a,b]=s.split('.');
    return [a, '.', b.slice(0,3), '.', b.slice(3)];
  }
  function renderFreq(){
    const mhz=(hz/1e6).toFixed(6);
    const [m,d]=mhz.split('.');
    const groups=[m,d.slice(0,3),d.slice(3)];
    const totalDigits=(m+d).length;
    const powers=[];
    for(let i=0;i<totalDigits;i++) powers.push(10**(totalDigits-1-i));
    let idx=0, html='';
    groups.forEach((grp,gi)=>{
      for(const ch of grp){
        const p=powers[idx++] || 1;
        html+=`<span class="digit${selectedDigitPower===p?' selected':''}" data-power="${p}">${ch}</span>`;
      }
      if(gi<2) html+='<span class="sep">.</span>';
    });
    $('#freq').innerHTML=html;
  }

  function redraw(){
    renderFreq();
    $('#bandLabel').textContent = band+'M · CW';
    const b=bands[band];
    $('#wfL').textContent=(b.min/1e6).toFixed(3);
    $('#wfC').textContent=(b.center/1e6).toFixed(3);
    $('#wfR').textContent=(b.max/1e6).toFixed(3)+' MHz';
    const pct=((hz-b.min)/(b.max-b.min))*100;
    $('#wfTune').style.left=Math.max(0,Math.min(100,pct))+'%';
    refreshRemoteVoices();
  }
  redraw();
  requestAnimationFrame(syncActivityPanelHeight);

  function log(msg){
    const d=document.createElement('div');
    d.innerHTML='<time>'+new Date().toISOString().slice(11,19)+'</time>'+msg;
    $('#log').prepend(d);
  }

  function clampHz(){
    hz=Math.max(bands[band].min,Math.min(bands[band].max,hz));
  }
  function tuneBy(delta){
    if(vfoTuneMode==='SCAN') setTuneMode('NORMAL');
    hz += delta; clampHz();
    const rot=((hz-bands[band].center)/1000)*14;
    $('#dial').style.setProperty('--rot',rot+'deg');
    redraw();
  }

  $('#waterfall').addEventListener('pointerdown',e=>{
    if(e.button!==undefined && e.button!==0) return;
    e.preventDefault();
    const r=$('#waterfall').getBoundingClientRect();
    const x=Math.max(0,Math.min(r.width,e.clientX-r.left));
    const b=bands[band];
    const target=b.min + (x/r.width)*(b.max-b.min);
    if(vfoTuneMode==='SCAN') setTuneMode('NORMAL');
    hz=Math.round(target);
    clampHz();
    redraw();
    scheduleStateSend(true);
  });
  const wheelTune=e=>{
    e.preventDefault();
    e.stopPropagation();
    const step=vfoStep*(vfoFast?10:1);
    tuneBy(e.deltaY<0?step:-step);
    scheduleStateSend();
  };
  $('#waterfall').addEventListener('wheel',wheelTune,{passive:false});
  $('#dial').addEventListener('wheel',wheelTune,{passive:false});

  function pointerAngle(e){
    const r=$('#dial').getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    return Math.atan2(e.clientY-cy,e.clientX-cx);
  }
  function angleDelta(a,b){
    let d=a-b;
    while(d>Math.PI) d-=Math.PI*2;
    while(d<-Math.PI) d+=Math.PI*2;
    return d;
  }

  $('#dial').addEventListener('pointerdown',e=>{
    e.preventDefault();
    dialDragging=true;
    dialLastAngle=pointerAngle(e);
    dialDragAccum=0;
    $('#dial').classList.add('dragging');
    $('#dial').setPointerCapture(e.pointerId);
  });

  $('#dial').addEventListener('pointermove',e=>{
    if(!dialDragging) return;
    e.preventDefault();
    const a=pointerAngle(e);
    const d=angleDelta(a,dialLastAngle);
    dialLastAngle=a;

    // One full physical turn = 100 tuning steps.
    dialDragAccum += d/(Math.PI*2)*100;
    const whole=Math.trunc(dialDragAccum);
    if(whole){
      const step=vfoStep*(vfoFast?10:1);
      tuneBy(whole*step);
      dialDragAccum -= whole;
    }
  });

  function endDialDrag(e){
    if(e) e.preventDefault();
    dialDragging=false;
    dialDragAccum=0;
    $('#dial').classList.remove('dragging');
  }
  $('#dial').addEventListener('pointerup',endDialDrag);
  $('#dial').addEventListener('pointercancel',endDialDrag);

  $('#freq').addEventListener('click',e=>{
    const d=e.target.closest('.digit'); if(!d) return;
    selectedDigitPower=+d.dataset.power; redraw();
  });
  $('#freq').addEventListener('wheel',e=>{
    const d=e.target.closest('.digit'); if(!d) return;
    e.preventDefault();
    selectedDigitPower=+d.dataset.power;
    tuneBy(e.deltaY<0?selectedDigitPower:-selectedDigitPower);
  },{passive:false});

  function stopScan(){
    if(scanTimer){ clearInterval(scanTimer); scanTimer=null; }
    scanHoldUntil=0;
  }
  function scanSignalNear(){
    let best=null, bestDf=Infinity;
    for(const [id,v] of remoteVoices){
      if(!v.down) continue;
      const st=remoteStations.get(id);
      if(!st || st.band!==band) continue;
      const df=Math.abs((st.hz||0)-hz);
      if(df<bestDf){ bestDf=df; best=st; }
    }
    for(const p of cwFramePlaybacks.values()){
      if(performance.now()>=(p.until||0))continue;
      const st=p.st;
      if(!st || st.band!==band)continue;
      const df=Math.abs((st.hz||0)-hz);
      if(df<bestDf){bestDf=df;best=st;}
    }
    return bestDf<=480 ? best : null;
  }
  function startScan(){
    stopScan();
    scanTimer=setInterval(()=>{
      if(vfoTuneMode!=='SCAN') return stopScan();
      const hit=scanSignalNear();
      if(hit){
        hz=Math.round(hit.hz); clampHz(); redraw(); scheduleStateSend();
        scanHoldUntil=Date.now()+2200;
        $('#vfoFast').textContent='TUNE · SCAN HOLD';
        return;
      }
      if(scanHoldUntil && Date.now()<scanHoldUntil) return;
      if(scanHoldUntil && Date.now()>=scanHoldUntil){
        scanHoldUntil=0; $('#vfoFast').textContent='TUNE · SCAN';
      }
      hz += 50;
      if(hz>bands[band].max) hz=bands[band].min;
      redraw();
      scheduleStateSend();
    },90);
  }
  function setTuneMode(mode){
    vfoTuneMode=mode;
    vfoFast=mode==='FAST';
    $('#vfoFast').classList.toggle('active',mode!=='NORMAL');
    $('#vfoFast').textContent='TUNE · '+mode;
    if(mode==='SCAN') startScan(); else stopScan();
  }
  $('#vfoFast').onclick=()=>{
    const next=vfoTuneMode==='NORMAL'?'FAST':(vfoTuneMode==='FAST'?'SCAN':'NORMAL');
    setTuneMode(next);
  };
  const steps=[1,10,100,1000];
  $('#vfoStep').onclick=()=>{
    const i=(steps.indexOf(vfoStep)+1)%steps.length;
    vfoStep=steps[i];
    $('#vfoStep').textContent='STEP · '+(vfoStep>=1000?(vfoStep/1000)+' kHz':vfoStep+' Hz');
  };

  $$('#bandButtons button').forEach(btn=>btn.onclick=()=>{
    const nextBand=+btn.dataset.band;
    if(vfoTuneMode==='SCAN') setTuneMode('NORMAL');
    if(nextBand===band) return;

    $$('#bandButtons button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    band=nextBand; hz=bands[band].center; redraw();
    $('#bandActivity').textContent=band+'M · …';
    updateNoiseLevel(); scheduleQrn(); scheduleQrm(); scheduleStatic(); scheduleRadioBursts(); resetDecoder();
    bandsUsed.add(band);
    $('#bandsUsedStat').textContent=bandsUsed.size;
    updateServiceUI();
    renderNpcList();
    log('Band changed to '+band+'m.');
    scheduleStateSend(true);
  });

  function toggle(btn){
    btn.classList.toggle('active');
    btn.textContent=btn.classList.contains('active')?'ON':'OFF';
  }
  $('#nb').onclick=()=>{toggle($('#nb')); updateNoiseLevel();};
  $('#nr').onclick=()=>{toggle($('#nr')); updateNoiseLevel();};
  $('#decode').onclick=()=>{
    toggle($('#decode'));
    const on=$('#decode').classList.contains('active');
    $('#mainDecode').classList.toggle('hidden',!on);
    if(on){ resetDecoder(); $('#decodeTicker').textContent='DATA · Listening…'; } else resetDecoder();
  };
  $('#reverse').onclick=()=>{
    if(keyMode!=='PADDLE') return;
    $('#reverse').classList.toggle('active');
    $('#reverse').textContent='REVERSE';
  };
  $('#iambicMode').onclick=()=>{
    if(keyMode!=='PADDLE') return;
    iambicMode = iambicMode==='A' ? 'B' : (iambicMode==='B' ? 'BUG' : 'A');
    $('#iambicMode').textContent=iambicMode;
    $('#iambicMode').classList.toggle('active',iambicMode!=='A');
    $('#keybar').textContent=iambicMode==='BUG'
      ? 'PADDLE · BUG'
      : 'PADDLE · IAMBIC '+iambicMode;
    log('Paddle mode '+iambicMode+'.');
  };
  $('#wf').onclick=()=>{
    toggle($('#wf'));
    $('#waterfall').style.display=$('#wf').classList.contains('active')?'block':'none';
  };
  $('#filter').onchange=()=>{ $('#filterText').textContent=$('#filter').value+' Hz'; refreshRemoteVoices(); updateNoiseLevel(); };
  function syncBreakIn(){
    const qsk=$('#breakin').value==='QSK';
    const off=$('#breakin').value==='OFF';
    $('#delay').disabled=qsk||off;
    $('#delay').closest('.ctrl').classList.toggle('disabledCtl',qsk||off);
    $('#delayText').textContent=qsk?'INSTANT':(off?'DISABLED':$('#delay').value+' ms');
  }
  $('#breakin').onchange=syncBreakIn;
  $('#delay').oninput=()=>{ if($('#breakin').value==='SEMI') $('#delayText').textContent=$('#delay').value+' ms'; };
  syncBreakIn();
  $('#power').oninput=()=>{
    $('#powerCtlText').textContent=$('#power').value+' W';
    $('#powerText').textContent=$('#power').value+' W';
    scheduleStateSend();
  };
  $('#wpm').oninput=()=>{
    $('#wpmCtlText').textContent=$('#wpm').value+' WPM';
    $('#wpmText').textContent=$('#wpm').value+' WPM';
    scheduleStateSend();
  };
  $('#tone').oninput=()=>{
    $('#toneCtlText').textContent=$('#tone').value+' Hz';
    $('#toneRead').textContent=$('#tone').value+' Hz';
    if(osc) osc.frequency.value=+$('#tone').value;
    refreshRemoteVoices();
    updateNoiseLevel();
  };
  $('#sideVol').oninput=()=>{
    $('#sideVolText').textContent=$('#sideVol').value==='0'?'OFF':$('#sideVol').value+'%';
  };
  $('#afVol').oninput=()=>{ $('#afVolText').textContent=$('#afVol').value==='0'?'OFF':$('#afVol').value+'%'; refreshRemoteVoices(); updateNoiseLevel(); };

  $$('.keybtn[data-keymode]').forEach(btn=>btn.onclick=()=>{
    const nextMode=btn.dataset.keymode;
    if(nextMode===keyMode) return;

    stopKeyerLoop(true);
    $$('.keybtn[data-keymode]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    keyMode=nextMode;

    const paddleOn=keyMode==='PADDLE';
    $('#iambicMode').disabled=!paddleOn;
    $('#iambicMode').classList.toggle('disabledCtl',!paddleOn);
    $('#reverse').disabled=!paddleOn;
    $('#keybar').textContent=keyMode==='STRAIGHT'
      ? 'SPACE / CTRL / [ ] / MOUSE / TOUCH · KEY'
      : (iambicMode==='BUG'
          ? 'PADDLE · BUG · LEFT DIT / RIGHT DAH'
          : 'PADDLE · IAMBIC '+iambicMode+' · LEFT DIT / RIGHT DAH');

    log('Key input: '+keyMode+'.');
    scheduleStateSend();
  });

  function setAnt(n){
    if(n===antenna) return;
    antenna=n;
    $('#ant1').classList.toggle('active',n===1);
    $('#ant2').classList.toggle('active',n===2);
    $('#antText').textContent=n===1?'1 · 3EL YAGI':'2 · ¼λ VERTICAL';
    $('#rotor').disabled=n!==1;
    log('ANT '+n+(n===1?' Yagi selected.':' vertical selected.'));
    scheduleStateSend();
  }
  $('#ant1').onclick=()=>setAnt(1);
  $('#ant2').onclick=()=>setAnt(2);
  $('#rotor').disabled=true;

  function shortestDelta(from,to){
    return ((to-from+540)%360)-180;
  }
  function updateRotorUI(){
    const az=Math.round(rotorActual);
    $('#rotorText').textContent=String(rotorTarget).padStart(3,'0')+'°';
    $('#azText').textContent=String(az).padStart(3,'0')+'°';
    $('#needle').style.setProperty('--az',rotorActual+'deg');
  }
  function driveRotor(){
    clearInterval(rotorTimer);
    $('#rotorStatus').textContent='ROTATING…';
    rotorTimer=setInterval(()=>{
      const d=shortestDelta(rotorActual,rotorTarget);
      if(Math.abs(d)<1){
        rotorActual=rotorTarget; clearInterval(rotorTimer); rotorTimer=null;
        $('#rotorStatus').textContent='READY';
        updateRotorUI(); return;
      }
      // ~45 degrees per second: noticeable but not painfully slow
      rotorActual=(rotorActual+Math.sign(d)*1.5+360)%360;
      updateRotorUI();
      refreshRemoteVoices();
      updateSmeter();
    },33);
  }
  $('#rotor').oninput=()=>{
    rotorTarget=+$('#rotor').value;
    $('#rotorText').textContent=String(rotorTarget).padStart(3,'0')+'°';
    driveRotor();
    scheduleStateSend();
  };

  function ensureAudio(){
    if(!audioCtx){
      const AC=window.AudioContext||window.webkitAudioContext;
      if(!AC) return false;
      audioCtx=new AC();
      gain=audioCtx.createGain(); gain.gain.value=0;
      rxMaster=audioCtx.createGain(); rxMaster.gain.value=0.55;
      rxGate=audioCtx.createGain(); rxGate.gain.value=1;
      gain.connect(audioCtx.destination);
      rxMaster.connect(rxGate); rxGate.connect(audioCtx.destination);
      osc=audioCtx.createOscillator();
      osc.type='sine';
      osc.frequency.value=+$('#tone').value;
      osc.connect(gain);
      osc.start();
      createNoise();
      startMeter();
    }
    if(audioCtx.state==='suspended'){
      audioCtx.resume().then(()=>{ audioUnlocked=true; }).catch(()=>{});
    } else {
      audioUnlocked=true;
    }
    return true;
  }

  function unlockAudio(){
    ensureAudio();
    if(audioCtx && audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
  }
  window.addEventListener('pointerdown',unlockAudio,{once:true,capture:true});
  window.addEventListener('keydown',unlockAudio,{once:true,capture:true});

  function createNoise(){
    const length=audioCtx.sampleRate*2;
    const buf=audioCtx.createBuffer(1,length,audioCtx.sampleRate);
    const data=buf.getChannelData(0);
    for(let i=0;i<length;i++) data[i]=(Math.random()*2-1)*0.58;
    noiseSource=audioCtx.createBufferSource(); noiseSource.buffer=buf; noiseSource.loop=true;
    noiseBandpass=audioCtx.createBiquadFilter(); noiseBandpass.type='bandpass';
    noiseGain=audioCtx.createGain();
    noiseSource.connect(noiseBandpass); noiseBandpass.connect(noiseGain); noiseGain.connect(rxMaster); noiseSource.start();

    const qlen=Math.max(512,Math.floor(audioCtx.sampleRate*.32));
    qrnBuffer=audioCtx.createBuffer(1,qlen,audioCtx.sampleRate);
    const qd=qrnBuffer.getChannelData(0);
    let prev=0;
    for(let i=0;i<qlen;i++){
      const t=i/audioCtx.sampleRate;
      const white=Math.random()*2-1;
      // Broad atmospheric crash: hard leading edge, low-frequency body,
      // then a long noisy decay. Avoids the fireplace/crackling texture.
      const body=prev*.78+white*.22; prev=body;
      const fast=Math.exp(-t/.018);
      const slow=Math.exp(-t/.105);
      qd[i]=(white*fast*.72 + body*slow*.82);
    }
    updateNoiseLevel();
    scheduleQrn();
    scheduleQrm();
    scheduleStatic();
    scheduleRadioBursts();
  }

  function filterCaptureHz(){
    const bw=+$('#filter').value;
    return ({600:300,1800:450,2500:500}[bw]||Math.min(500,Math.max(120,bw/2)));
  }

  function updateNoiseLevel(){
    if(!noiseGain || !audioCtx) return;
    const bw=+$('#filter').value;
    const widthFactor={600:.58,1800:.88,2500:1}[bw]||1;
    const base={40:.185,20:.125,15:.085,10:.052}[band]||.08;
    const nr=$('#nr').classList.contains('active')?.46:1;
    noiseGain.gain.setTargetAtTime(base*widthFactor*nr,audioCtx.currentTime,.08);
    if(noiseBandpass){
      const tone=+$('#tone').value;
      noiseBandpass.frequency.setTargetAtTime(tone,audioCtx.currentTime,.05);
      noiseBandpass.Q.setTargetAtTime(Math.max(.35,tone/Math.max(300,bw)),audioCtx.currentTime,.05);
    }
    rxMaster.gain.setTargetAtTime((+$('#afVol').value/100),audioCtx.currentTime,.04);
  }

  function scheduleQrn(){
    clearTimeout(qrnTimer);
    if(!audioCtx)return;
    const bandRate={40:.90,20:.62,15:.39,10:.23}[band]||.42;
    const kp=Number.isFinite(spaceWeather.kp)?spaceWeather.kp:2;
    const delay=(3200+Math.random()*9000)/Math.max(.35,bandRate*(1+kp*.035));

    qrnTimer=setTimeout(()=>{
      if(audioCtx&&qrnBuffer&&rxMaster){
        const nb=$('#nb').classList.contains('active');
        const nr=$('#nr').classList.contains('active');
        const strikes=Math.random()<.28?2:1;

        for(let s=0;s<strikes;s++){
          const src=audioCtx.createBufferSource();src.buffer=qrnBuffer;

          const hp=audioCtx.createBiquadFilter();hp.type='highpass';
          hp.frequency.value=120+Math.random()*250;hp.Q.value=.35;

          const lp=audioCtx.createBiquadFilter();lp.type='lowpass';
          lp.frequency.value=2100+Math.random()*2600;lp.Q.value=.42;

          const g=audioCtx.createGain();
          const base={40:.34,20:.23,15:.145,10:.090}[band]||.14;
          const amp=base*(.75+Math.random()*.9)*(nb?.20:1)*(nr?.80:1);
          const when=audioCtx.currentTime+s*(.055+Math.random()*.15);

          g.gain.setValueAtTime(.0001,when);
          g.gain.exponentialRampToValueAtTime(Math.max(.001,amp),when+.003);
          g.gain.exponentialRampToValueAtTime(Math.max(.0008,amp*.18),when+.11+Math.random()*.09);
          g.gain.exponentialRampToValueAtTime(.0008,when+.28+Math.random()*.22);

          src.connect(hp);hp.connect(lp);lp.connect(g);g.connect(rxMaster);
          src.start(when);
        }
      }
      scheduleQrn();
    },delay);
  }

  let qrmTimer=null,staticTimer=null,burstTimer=null;
  function scheduleQrm(){
    clearTimeout(qrmTimer);
    if(!audioCtx)return;
    // QRM = other RF users/carriers. Keep it sparse; the static layer below
    // provides most of the "alive band" texture.
    const rate={40:1.0,20:.62,15:.34,10:.18}[band]||.35;
    const delay=(6500+Math.random()*13500)/Math.max(.15,rate);
    qrmTimer=setTimeout(()=>{
      if(audioCtx&&rxMaster){
        const oscQ=audioCtx.createOscillator();
        const g=audioCtx.createGain();
        const offset=(Math.random()<.5?-1:1)*(110+Math.random()*470);
        oscQ.type=Math.random()<.82?'sine':'triangle';
        oscQ.frequency.value=Math.max(180,(+$('#tone').value)+offset);
        const nb=$('#nb').classList.contains('active');
        const nr=$('#nr').classList.contains('active');
        const bandAmp={40:.050,20:.034,15:.022,10:.014}[band]||.022;
        const amp=bandAmp*(nr?.75:1);
        const t=audioCtx.currentTime;
        // Sometimes a brief heterodyne, sometimes a few crude CW-like chops.
        if(Math.random()<.45){
          const dur=.28+Math.random()*1.3;
          g.gain.setValueAtTime(0,t);
          g.gain.linearRampToValueAtTime(amp,t+.025);
          g.gain.setValueAtTime(amp,t+Math.max(.04,dur-.05));
          g.gain.linearRampToValueAtTime(0,t+dur);
          oscQ.start(t);oscQ.stop(t+dur+.03);
        }else{
          let tt=t;const unit=.045+Math.random()*.055;
          g.gain.setValueAtTime(0,tt);
          for(let i=0;i<3+Math.floor(Math.random()*6);i++){
            const mark=(Math.random()<.68?1:3)*unit;
            g.gain.setValueAtTime(0,tt);
            g.gain.linearRampToValueAtTime(amp,tt+.003);
            g.gain.setValueAtTime(amp,tt+Math.max(.004,mark-.004));
            g.gain.linearRampToValueAtTime(0,tt+mark);
            tt+=mark+unit*(1+Math.floor(Math.random()*2));
          }
          oscQ.start(t);oscQ.stop(tt+.03);
        }
        oscQ.connect(g);g.connect(rxMaster);
      }
      scheduleQrm();
    },delay);
  }

  function scheduleStatic(){
    clearTimeout(staticTimer);
    if(!audioCtx)return;

    // Sparse sharp electrical clicks remain, but they are now a minor layer.
    const density={40:.75,20:.55,15:.38,10:.24}[band]||.4;
    const delay=(1700+Math.random()*5200)/density;

    staticTimer=setTimeout(()=>{
      if(audioCtx&&rxMaster){
        const nb=$('#nb').classList.contains('active');
        const nr=$('#nr').classList.contains('active');

        const dur=.012+Math.random()*.045;
        const len=Math.max(128,Math.floor(audioCtx.sampleRate*dur));
        const buf=audioCtx.createBuffer(1,len,audioCtx.sampleRate);
        const d=buf.getChannelData(0);

        for(let i=0;i<len;i++){
          const t=i/audioCtx.sampleRate;
          const white=Math.random()*2-1;
          const env=Math.exp(-t/(.006+Math.random()*.010));
          d[i]=white*env;
        }

        const src=audioCtx.createBufferSource();src.buffer=buf;
        const hp=audioCtx.createBiquadFilter();hp.type='highpass';
        hp.frequency.value=900+Math.random()*1800;hp.Q.value=.55;
        const g=audioCtx.createGain();
        const base={40:.085,20:.060,15:.040,10:.025}[band]||.04;
        g.gain.value=base*(.6+Math.random()*.85)*(nb?.16:1)*(nr?.78:1);

        src.connect(hp);hp.connect(g);g.connect(rxMaster);
        src.start();
      }
      scheduleStatic();
    },delay);
  }

  function scheduleRadioBursts(){
    clearTimeout(burstTimer);
    if(!audioCtx)return;

    // Radio-like impulsive static: broader "shhh-KRSHH" bursts with a fast rise,
    // noisy body and uneven decay. This is the dominant transient layer.
    const density={40:1.0,20:.72,15:.48,10:.30}[band]||.5;
    const delay=(950+Math.random()*3600)/density;

    burstTimer=setTimeout(()=>{
      if(audioCtx&&rxMaster){
        const nb=$('#nb').classList.contains('active');
        const nr=$('#nr').classList.contains('active');

        const duration=.10+Math.random()*.42;
        const len=Math.max(512,Math.floor(audioCtx.sampleRate*duration));
        const buf=audioCtx.createBuffer(1,len,audioCtx.sampleRate);
        const d=buf.getChannelData(0);

        let low=0, mid=0;
        const rise=.004+Math.random()*.010;
        const fall=.055+Math.random()*.20;
        const gateFreq=7+Math.random()*18;
        const phase=Math.random()*Math.PI*2;

        for(let i=0;i<len;i++){
          const t=i/audioCtx.sampleRate;
          const white=Math.random()*2-1;
          low=low*.94+white*.06;
          mid=mid*.74+white*.26;

          const attack=1-Math.exp(-t/rise);
          const decay=Math.exp(-t/fall);
          const flutter=.72+.28*Math.max(0,Math.sin(2*Math.PI*gateFreq*t+phase));
          const env=attack*decay*flutter;

          d[i]=(white*.58 + mid*.58 + low*.34)*env;
        }

        const src=audioCtx.createBufferSource();src.buffer=buf;

        const hp=audioCtx.createBiquadFilter();hp.type='highpass';
        hp.frequency.value=180+Math.random()*420;hp.Q.value=.45;

        const lp=audioCtx.createBiquadFilter();lp.type='lowpass';
        lp.frequency.value=2200+Math.random()*2600;lp.Q.value=.38;

        const g=audioCtx.createGain();
        const base={40:.20,20:.14,15:.090,10:.055}[band]||.09;
        const amp=base*(.70+Math.random()*.95)*(nb?.25:1)*(nr?.76:1);
        g.gain.value=amp;

        src.connect(hp);hp.connect(lp);lp.connect(g);g.connect(rxMaster);
        src.start();

        // Sometimes a second impulse follows shortly after, like RF hash or a
        // nearby switching source rather than a "fire crackle".
        if(Math.random()<.32){
          const src2=audioCtx.createBufferSource();src2.buffer=buf;
          const bp2=audioCtx.createBiquadFilter();bp2.type='bandpass';
          bp2.frequency.value=700+Math.random()*1700;bp2.Q.value=.55;
          const g2=audioCtx.createGain();g2.gain.value=amp*(.35+Math.random()*.35);
          src2.connect(bp2);bp2.connect(g2);g2.connect(rxMaster);
          src2.start(audioCtx.currentTime+.07+Math.random()*.20);
        }
      }
      scheduleRadioBursts();
    },delay);
  }

  function ramp(to,ms=5){
    if(!ensureAudio() || !audioCtx || !gain) return;
    const t=audioCtx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value,t);
    gain.gain.linearRampToValueAtTime(to,t+ms/1000);
  }

  function setRxGate(open,ms=5){
    if(!ensureAudio() || !audioCtx || !rxGate) return;
    const t=audioCtx.currentTime;
    rxGate.gain.cancelScheduledValues(t);
    rxGate.gain.setTargetAtTime(open?1:0,t,Math.max(.002,ms/1000));
  }
  function setTxRxUi(isTx){
    rxHoldActive=!!isTx;
    $('#txFlag').textContent=isTx?'TX':'RX';
    $('#txFlag').classList.toggle('tx',isTx);
    if(!isTx) updateSmeter();
  }
  function txRxSwitchDown(){
    clearTimeout(rxReturnTimer);
    setTxRxUi(true);
    const mode=$('#breakin').value;
    if(mode==='QSK') setRxGate(false,2);
    else setRxGate(false,5);
  }
  function txRxSwitchUp(){
    clearTimeout(rxReturnTimer);
    const mode=$('#breakin').value;
    if(mode==='QSK'){
      setRxGate(true,3);
      setTxRxUi(false);
      return;
    }
    const hold=mode==='SEMI' ? +$('#delay').value : 1000;
    // Stay visibly in TX and keep RX muted for the selected hang time.
    rxReturnTimer=setTimeout(()=>{
      setRxGate(true,18);
      setTxRxUi(false);
    },hold);
  }
  function keyDown(){
    if(tx) return;
    tx=true; lastKeyDown=performance.now(); txStartMs=Date.now();
    txRxSwitchDown();
    wfKeyDown('LOCAL',hz,'human');
    $('#keybar').classList.add('down'); $('#keybar').textContent='TX · KEY DOWN';
    $('#sfill').style.width='3%'; $('#sigText').textContent='TX';
    ramp((+$('#sideVol').value/100)*0.28,4);
    sendNet({type:'key_down', band, hz, seq:++netSeq, t:Date.now(), power:+$('#power').value});
  }
  function keyUp(){
    if(!tx) return;
    tx=false;
    if(txStartMs){ txAccumMs+=Date.now()-txStartMs; txStartMs=0; }
    wfKeyUp('LOCAL');
    $('#keybar').classList.remove('down');
    $('#keybar').textContent=keyMode==='STRAIGHT'?'SPACE / CTRL / [ ] / TOUCH · KEY':(iambicMode==='BUG'?'PADDLE · BUG':'PADDLE · IAMBIC '+iambicMode);
    ramp(0,5);
    txRxSwitchUp();
    sendNet({type:'key_up', band, hz, seq:++netSeq, t:Date.now()});
  }
  function isDitCode(e){ return e.code==='ControlLeft' || e.code==='BracketLeft'; }
  function isDahCode(e){ return e.code==='ControlRight' || e.code==='BracketRight'; }

  function ditMs(){ return 1200 / Math.max(5,+$('#wpm').value); }

  function cancelKeyer(){
    keyerGeneration++;
    if(keyerLoopTimer){ clearTimeout(keyerLoopTimer); keyerLoopTimer=null; }
    if(keyerElementActive){
      keyerElementActive=false;
      if(tx) keyUp();
    }
  }

  function keyerMark(kind,generation,next){
    if(generation!==keyerGeneration) return;
    const unit=ditMs();
    const mark=kind==='dah' ? unit*3 : unit;
    keyerElementActive=true;
    keyDown();
    keyerLoopTimer=setTimeout(()=>{
      if(generation!==keyerGeneration){
        keyerElementActive=false;
        if(tx) keyUp();
        return;
      }
      keyUp();
      keyerElementActive=false;
      keyerLoopTimer=setTimeout(()=>{
        keyerLoopTimer=null;
        if(generation===keyerGeneration) next();
      }, unit);
    }, mark);
  }

  function nextIambic(){
    const squeeze=paddleDit && paddleDah;
    if(squeeze){
      squeezeWasActive=true;
      squeezeReleasePending=false;
      lastIambic = lastIambic==='dit' ? 'dah' : 'dit';
      return lastIambic;
    }

    // Iambic B: when a squeeze is released, send one final opposite element.
    if(iambicMode==='B' && squeezeWasActive && !paddleDit && !paddleDah && !squeezeReleasePending){
      squeezeReleasePending=true;
      squeezeWasActive=false;
      lastIambic = lastIambic==='dit' ? 'dah' : 'dit';
      return lastIambic;
    }

    if(!paddleDit && !paddleDah){
      squeezeWasActive=false;
      squeezeReleasePending=false;
      return null;
    }

    if(paddleDit){ lastIambic='dit'; return 'dit'; }
    if(paddleDah){ lastIambic='dah'; return 'dah'; }
    return null;
  }

  function runKeyer(){
    if(keyMode!=='PADDLE' || iambicMode==='BUG') return;
    if(keyerLoopTimer || keyerElementActive) return;
    const generation=keyerGeneration;

    const step=()=>{
      if(generation!==keyerGeneration || keyMode!=='PADDLE' || iambicMode==='BUG') return;
      const el=nextIambic();
      if(!el){
        keyerLoopTimer=null;
        keyerElementActive=false;
        if(tx) keyUp();
        return;
      }
      keyerMark(el,generation,step);
    };

    step();
  }

  function stopKeyerLoop(force=false){
    cancelKeyer();
    keyerElementActive=false;
    squeezeWasActive=false;
    squeezeReleasePending=false;
    if(force){
      paddleDit=false;
      paddleDah=false;
      manualDahDown=false;
    }
    if(tx) keyUp();
  }

  function runBugDits(){
    if(keyMode!=='PADDLE' || iambicMode!=='BUG' || !paddleDit || manualDahDown) return;
    if(keyerLoopTimer || keyerElementActive) return;
    const generation=keyerGeneration;
    const step=()=>{
      if(generation!==keyerGeneration || keyMode!=='PADDLE' || iambicMode!=='BUG' || !paddleDit || manualDahDown) return;
      keyerMark('dit',generation,step);
    };
    step();
  }

  function isEditing(){
    const el=document.activeElement;
    return !!(el && (el.isContentEditable || ['INPUT','SELECT','TEXTAREA'].includes(el.tagName)));
  }
  function directPress(token){
    if(directHeld.has(token)) return;
    directHeld.add(token);
    keyDown();
  }
  function directRelease(token){
    directHeld.delete(token);
    if(directHeld.size===0) keyUp();
  }

  window.addEventListener('keydown',e=>{
    if(e.code==='Space' && !isEditing()){
      e.preventDefault();
      e.stopPropagation();
    }
  },{capture:true,passive:false});
  window.addEventListener('keyup',e=>{
    if(e.code==='Space' && !isEditing()){
      e.preventDefault();
      e.stopPropagation();
    }
  },{capture:true,passive:false});

  document.addEventListener('keydown',e=>{
    if(e.repeat) return;

    if(e.code==='Space'){
      if(!isEditing()){ e.preventDefault(); e.stopPropagation(); directPress(e.code); }
      return;
    }

    if((isDitCode(e)||isDahCode(e)) && keyMode==='STRAIGHT'){
      if(!isEditing()){ e.preventDefault(); directPress(e.code); }
      return;
    }

    if(isDitCode(e)){
      e.preventDefault();
      const ditInput = $('#reverse').classList.contains('active') ? 'dah' : 'dit';
      if(ditInput==='dit') paddleDit=true; else paddleDah=true;
      if(keyMode==='PADDLE'){
        if(iambicMode==='BUG'){
          if(ditInput==='dit') runBugDits();
          else { manualDahDown=true; cancelKeyer(); if(!tx) keyDown(); }
        } else runKeyer();
      }
      return;
    }

    if(isDahCode(e)){
      e.preventDefault();
      const dahInput = $('#reverse').classList.contains('active') ? 'dit' : 'dah';
      if(dahInput==='dit') paddleDit=true; else paddleDah=true;
      if(keyMode==='PADDLE'){
        if(iambicMode==='BUG'){
          if(dahInput==='dit') runBugDits();
          else { manualDahDown=true; cancelKeyer(); if(!tx) keyDown(); }
        } else runKeyer();
      }
    }
  });

  document.addEventListener('keyup',e=>{
    if(e.code==='Space'){
      if(!isEditing()){ e.preventDefault(); e.stopPropagation(); directRelease(e.code); }
      return;
    }

    if((isDitCode(e)||isDahCode(e)) && keyMode==='STRAIGHT'){
      if(!isEditing()){ e.preventDefault(); directRelease(e.code); }
      return;
    }

    if(isDitCode(e)){
      e.preventDefault();
      const ditInput = $('#reverse').classList.contains('active') ? 'dah' : 'dit';
      if(ditInput==='dit') paddleDit=false; else paddleDah=false;
      if(keyMode==='PADDLE' && iambicMode!=='BUG' && !keyerLoopTimer && !keyerElementActive) runKeyer();
      if(keyMode==='PADDLE' && iambicMode==='BUG' && ditInput==='dah'){
        manualDahDown=false;
        if(tx && !keyerElementActive) keyUp();
        if(paddleDit) runBugDits();
      }
      return;
    }

    if(isDahCode(e)){
      e.preventDefault();
      const dahInput = $('#reverse').classList.contains('active') ? 'dit' : 'dah';
      if(dahInput==='dit') paddleDit=false; else paddleDah=false;
      if(keyMode==='PADDLE' && iambicMode!=='BUG' && !keyerLoopTimer && !keyerElementActive) runKeyer();
      if(keyMode==='PADDLE' && iambicMode==='BUG' && dahInput==='dah'){
        manualDahDown=false;
        if(tx && !keyerElementActive) keyUp();
        if(paddleDit) runBugDits();
      }
    }
  });

  const keybar=$('#keybar');
  const mousePaddleHeld=new Map();

  function applyMousePaddle(button,down){
    if(keyMode!=='PADDLE') return false;
    if(button!==0 && button!==2) return false;

    // Left = DIT, right = DAH. REVERSE swaps them, same as keyboard paddle inputs.
    let element=button===0?'dit':'dah';
    if($('#reverse').classList.contains('active')) element=element==='dit'?'dah':'dit';

    if(down){
      if(mousePaddleHeld.has(button)) return true;
      mousePaddleHeld.set(button,element);
      if(element==='dit') paddleDit=true; else paddleDah=true;

      if(iambicMode==='BUG'){
        if(element==='dit') runBugDits();
        else{
          manualDahDown=true;
          cancelKeyer();
          if(!tx) keyDown();
        }
      }else runKeyer();
    }else{
      const held=mousePaddleHeld.get(button)||element;
      mousePaddleHeld.delete(button);
      if(held==='dit') paddleDit=false; else paddleDah=false;

      if(iambicMode==='BUG' && held==='dah'){
        manualDahDown=false;
        if(tx && !keyerElementActive) keyUp();
        if(paddleDit) runBugDits();
      }else if(iambicMode!=='BUG' && !keyerLoopTimer && !keyerElementActive){
        runKeyer();
      }
    }
    return true;
  }

  keybar.addEventListener('contextmenu',e=>e.preventDefault());
  keybar.addEventListener('dragstart',e=>e.preventDefault());
  keybar.addEventListener('selectstart',e=>e.preventDefault());
  keybar.addEventListener('pointerdown',e=>{
    e.preventDefault();
    e.stopPropagation();
    try{keybar.setPointerCapture(e.pointerId)}catch{}

    if(keyMode==='PADDLE' && applyMousePaddle(e.button,true)) return;

    // Straight key: either primary or secondary mouse button keys the transmitter.
    if(e.button===0 || e.button===2) directPress('POINTER_'+e.pointerId);
  });

  const releasePointer=e=>{
    e.preventDefault();
    e.stopPropagation();

    if(keyMode==='PADDLE'){
      applyMousePaddle(e.button,false);
    }else{
      directRelease('POINTER_'+e.pointerId);
    }

    try{
      if(keybar.hasPointerCapture(e.pointerId))keybar.releasePointerCapture(e.pointerId);
    }catch{}
  };

  keybar.addEventListener('pointerup',releasePointer);
  keybar.addEventListener('pointercancel',e=>{
    e.preventDefault();
    mousePaddleHeld.clear();
    paddleDit=false;paddleDah=false;manualDahDown=false;
    directRelease('POINTER_'+e.pointerId);
    if(tx && !keyerElementActive) keyUp();
  });
  keybar.addEventListener('lostpointercapture',e=>{
    directRelease('POINTER_'+e.pointerId);
  });

  // Safety release even if the pointer leaves the manipulation area/browser chrome.
  window.addEventListener('pointerup',e=>{
    if(mousePaddleHeld.has(e.button)) applyMousePaddle(e.button,false);
  },{capture:true});
  window.addEventListener('blur',()=>{
    directHeld.clear();paddleDit=false;paddleDah=false;manualDahDown=false;
    stopKeyerLoop(true);if(tx)keyUp();
  });
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      directHeld.clear();paddleDit=false;paddleDah=false;manualDahDown=false;
      stopKeyerLoop(true);if(tx)keyUp();
    }
  });


  // -------- Realtime-ready waterfall event model --------
  const wfCanvas=$('#wfCanvas');
  const wfCtx=wfCanvas.getContext('2d',{alpha:true});
  let wfLast=performance.now();
  let wfAccum=0;
  const wfScrollPxPerSec=70;

  let wfDpr=Math.max(1,window.devicePixelRatio||1);
  const wfScratch=document.createElement('canvas');
  const wfScratchCtx=wfScratch.getContext('2d',{alpha:true});

  function resizeWaterfallCanvas(){
    const r=$('#waterfall').getBoundingClientRect();
    wfDpr=Math.max(1,window.devicePixelRatio||1);
    const cssW=Math.max(1,Math.round(r.width));
    const cssH=Math.max(1,Math.round(r.height));

    wfScratch.width=wfCanvas.width||Math.round(cssW*wfDpr);
    wfScratch.height=wfCanvas.height||Math.round(cssH*wfDpr);
    wfScratchCtx.setTransform(1,0,0,1,0,0);
    wfScratchCtx.clearRect(0,0,wfScratch.width,wfScratch.height);
    if(wfCanvas.width&&wfCanvas.height) wfScratchCtx.drawImage(wfCanvas,0,0);

    wfCanvas.width=Math.round(cssW*wfDpr);
    wfCanvas.height=Math.round(cssH*wfDpr);
    wfCanvas.style.width=cssW+'px';
    wfCanvas.style.height=cssH+'px';
    wfCtx.setTransform(1,0,0,1,0,0);
    wfCtx.clearRect(0,0,wfCanvas.width,wfCanvas.height);
    wfCtx.imageSmoothingEnabled=false;
    if(wfScratch.width&&wfScratch.height) wfCtx.drawImage(wfScratch,0,0,wfScratch.width,wfScratch.height,0,0,wfCanvas.width,wfCanvas.height);
  }
  resizeWaterfallCanvas();
  window.addEventListener('resize',()=>{ resizeWaterfallCanvas(); syncActivityPanelHeight(); });

  function freqToX(freq){
    const b=bands[band];
    return ((freq-b.min)/(b.max-b.min))*wfCanvas.clientWidth;
  }

  function wfKeyDown(id,freq,kind='human'){
    activeTraces.set(id,{freq,kind});
  }

  function wfKeyUp(id){
    activeTraces.delete(id);
  }

  function wfColor(kind){
    if(kind==='service') return 'rgba(255,196,72,1)';
    if(kind==='bot') return 'rgba(158,249,183,.55)';
    return 'rgba(158,249,183,.95)';
  }

  function isNearServiceFreq(freq){
    return Math.abs(freq-serviceFreqByBand[band]) <= 35;
  }

  function scrollWaterfall(ts){
    const dt=Math.min(0.05,(ts-wfLast)/1000 || 0);
    wfLast=ts;
    wfAccum += wfScrollPxPerSec*dt;

    const w=wfCanvas.width;
    const h=wfCanvas.height;

    if(w>0 && h>0 && wfAccum>=1){
      const dyCss=Math.floor(wfAccum);
      wfAccum-=dyCss;
      const dy=Math.max(1,Math.round(dyCss*wfDpr));
      wfScratch.width=w; wfScratch.height=h;
      wfScratchCtx.setTransform(1,0,0,1,0,0);
      wfScratchCtx.globalCompositeOperation='copy';
      wfScratchCtx.drawImage(wfCanvas,0,0);
      wfCtx.setTransform(1,0,0,1,0,0);
      wfCtx.clearRect(0,0,w,h);
      if(h>dy) wfCtx.drawImage(wfScratch,0,0,w,h-dy,0,dy,w,h-dy);
    }

    // Draw current keyed energy at the top edge in backing-store pixels.
    const traces=[...activeTraces.values()].sort((a,b)=>(a.kind==='service')-(b.kind==='service'));
    traces.forEach(t=>{
      if(t.kind!=='service' && isNearServiceFreq(t.freq)) return;
      const xCss=freqToX(t.freq);
      if(xCss<0 || xCss>w/wfDpr) return;
      const x=Math.round(xCss*wfDpr);
      wfCtx.fillStyle=wfColor(t.kind);
      const traceW=Math.max(2,Math.round((t.kind==='service'?7:3)*wfDpr));
      const traceH=Math.max(2,Math.round((t.kind==='service'?4:3)*wfDpr));
      wfCtx.fillRect(Math.round(x-traceW/2),0,traceW,traceH);
    });

    requestAnimationFrame(scrollWaterfall);
  }
  requestAnimationFrame(scrollWaterfall);

  // -------- Network services / active station spots --------
  function updateServiceUI(){ return serviceFreqByBand[band]; }
  function renderNpcList(){
    const rows=[{
      freq:serviceFreqByBand[band],
      label:'NETWORK INFO',
      kind:'service'
    }];

    const bots=[...remoteStations.values()]
      .filter(s=>s.kind==='virtual' && s.band===band)
      .sort((a,b)=>(a.hz||0)-(b.hz||0));

    bots.forEach(s=>rows.push({
      freq:s.hz,
      label:`${s.callsign||'—'} · ${s.role||'CQ'} · ${s.wpm||13} WPM`,
      kind:'bot'
    }));

    $('#npcList').innerHTML=rows.map(s=>
      `<div class="bandnpc" data-freq="${Math.round(s.freq||0)}" title="Tune to ${(s.freq/1e6).toFixed(6)} MHz">
        <b>${(s.freq/1e6).toFixed(6)} MHz</b>
        <span>${s.label}</span>
      </div>`
    ).join('');

    // The service panel doubles as a spot list: click any row to tune there.
    $$('#npcList .bandnpc').forEach(row=>{
      row.style.cursor='pointer';
      row.onclick=()=>{
        const target=Number(row.dataset.freq);
        if(!Number.isFinite(target)) return;
        if(vfoTuneMode==='SCAN') setTuneMode('NORMAL');
        hz=target; clampHz(); redraw(); scheduleStateSend(true);
      };
    });
  }
  $('#activityDetailsToggle').onchange=()=>{
    $('#activityDetails').classList.toggle('servicesHidden',!$('#activityDetailsToggle').checked);
    if($('#activityDetailsToggle').checked) renderNpcList();
  };

  const STATION_STORAGE_KEY='cwNetworkStationV1';
  let stationSavedSnapshot='';

  function normalizedStationIdentity(){
    return {
      callsign:($('#callsign').value||'').trim().toUpperCase().replace(/\s+/g,'').slice(0,16),
      locator:($('#locator').value||'').trim().toUpperCase().replace(/\s+/g,'').slice(0,10)
    };
  }
  function validCallsign(v){
    return /^(?=.{3,12}$)(?=.*[A-Z])(?=.*\d)[A-Z0-9]+(?:\/[A-Z0-9]+)?$/.test(v);
  }
  function validLocator(v){
    return !v || /^[A-R]{2}\d{2}(?:[A-X]{2})?$/.test(v);
  }
  function setStationFeedback(text,state=''){
    const el=$('#stationSaveStatus');
    el.textContent=text;
    el.classList.remove('ok','warn','err');
    if(state)el.classList.add(state);
  }
  function updateStationDirtyUi(){
    const id=normalizedStationIdentity();
    const sig=JSON.stringify(id);
    const dirty=sig!==stationSavedSnapshot;
    $('#saveStation').classList.toggle('dirty',dirty);
    $('#saveStation').textContent=stationSavedSnapshot?(dirty?'SAVE CHANGES':'SAVED'):'SAVE STATION';
    if(dirty && stationSavedSnapshot)setStationFeedback('Unsaved changes','warn');
  }
  function loadStationIdentity(){
    try{
      const saved=JSON.parse(localStorage.getItem(STATION_STORAGE_KEY)||'null');
      if(saved && typeof saved==='object'){
        $('#callsign').value=String(saved.callsign||'').toUpperCase().slice(0,16);
        $('#locator').value=String(saved.locator||'').toUpperCase().slice(0,10);
        stationSavedSnapshot=JSON.stringify(normalizedStationIdentity());
        setStationFeedback('Saved locally','ok');
        $('#saveStation').textContent='SAVED';
        return;
      }
    }catch(_){}
    stationSavedSnapshot='';
    setStationFeedback('Not saved','');
  }
  function saveStationIdentity(){
    const id=normalizedStationIdentity();
    $('#callsign').value=id.callsign;
    $('#locator').value=id.locator;
    if(!validCallsign(id.callsign)){
      setStationFeedback('Invalid callsign','err');
      $('#saveStation').classList.add('dirty');
      return false;
    }
    if(!validLocator(id.locator)){
      setStationFeedback('Invalid locator','err');
      $('#saveStation').classList.add('dirty');
      return false;
    }
    try{
      localStorage.setItem(STATION_STORAGE_KEY,JSON.stringify(id));
      stationSavedSnapshot=JSON.stringify(id);
      $('#saveStation').classList.remove('dirty');
      $('#saveStation').textContent='SAVED';
      setStationFeedback('Saved locally','ok');
      scheduleStateSend(true);
      refreshRemoteVoices();
      return true;
    }catch(_){
      setStationFeedback('Could not save','err');
      return false;
    }
  }
  $('#saveStation').onclick=saveStationIdentity;
  ['callsign','locator'].forEach(id=>{
    $('#'+id).addEventListener('input',()=>{
      $('#'+id).value=$('#'+id).value.toUpperCase();
      updateStationDirtyUi();
    });
  });
  loadStationIdentity();

  function stationPayload(){
    return {
      type:'station_state', band, hz, callsign:($('#callsign').value||'').trim().toUpperCase().slice(0,16),
      locator:($('#locator').value||'').trim().toUpperCase().slice(0,10), power:+$('#power').value,
      antenna, azimuth:Math.round(rotorActual), wpm:+$('#wpm').value, keyMode, iambicMode
    };
  }
  function sendNet(obj){
    if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function scheduleStateSend(final=false){
    clearTimeout(stateSendTimer);
    stateSendTimer=setTimeout(()=>{
      const p=stationPayload(); const sig=JSON.stringify(p);
      if(sig===lastStateSent) return;
      lastStateSent=sig; sendNet(p);
    },final?0:60);
  }
  function silenceAllRemoteVoices(reason='network reset'){
    if(audioCtx){
      const now=audioCtx.currentTime;
      for(const [id,v] of remoteVoices){
        try{
          v.down=false;
          if(v.safetyTimer){ clearTimeout(v.safetyTimer); v.safetyTimer=null; }
          v.gain.gain.cancelScheduledValues(now);
          v.gain.gain.setTargetAtTime(0,now,.008);
        }catch(_){}
        try{ wfKeyUp(id); }catch(_){}
      }
    }else{
      for(const [id,v] of remoteVoices){
        v.down=false;
        if(v.safetyTimer){ clearTimeout(v.safetyTimer); v.safetyTimer=null; }
        try{ wfKeyUp(id); }catch(_){}
      }
    }
    updateSmeter();
  }

  function connectNetwork(){
    clearTimeout(reconnectTimer);
    const generation=++socketGeneration;
    if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)){
      try{ ws.onclose=null; ws.close(); }catch(_){}
    }
    $('#netState').textContent=connectedOnce?'RECONNECTING':'CONNECTING';
    let sock;
    try{ sock=new WebSocket(WS_URL); ws=sock; }catch(e){ return scheduleReconnect(); }
    sock.onopen=()=>{
      if(generation!==socketGeneration) return;
      reconnectAttempts=0;
      connectedOnce=true; $('#netState').textContent='ONLINE'; log('Network connected.');
      lastStateSent=''; scheduleStateSend(true);
    };
    sock.onclose=()=>{
      if(generation!==socketGeneration) return;
      silenceAllRemoteVoices('socket close');
      for(const id of [...cwFramePlaybacks.keys()])stopFramePlayback(id);
      $('#netState').textContent='RECONNECTING';
      log('Network connection lost. Reconnecting…');
      scheduleReconnect();
    };
    sock.onerror=()=>{};
    sock.onmessage=e=>{
      if(generation!==socketGeneration) return;
      try{ handleNet(JSON.parse(e.data)); }catch(_){}
    };
  }
  function scheduleReconnect(){
    clearTimeout(reconnectTimer);
    reconnectAttempts=Math.min(6,reconnectAttempts+1);
    const delay=Math.min(10000,1200*Math.pow(1.7,reconnectAttempts-1))+Math.random()*450;
    reconnectTimer=setTimeout(connectNetwork,delay);
  }

  function handleNet(m){
    if(m.type==='welcome'){ stationId=m.stationId||stationId; return; }
    if(m.type==='presence'){
      $('#onlineUsers').textContent=m.online??0;
      if(m.activity && m.activity[band]) $('#bandActivity').textContent=band+'M · '+m.activity[band];
      return;
    }
    if(m.type==='snapshot'){
      remoteStations.clear();
      (m.stations||[]).forEach(s=>{
        remoteStations.set(s.stationId,s);
        if(s.keyDown && s.stationId!==stationId) remoteKeyDown(s);
      });
      renderNpcList();
      return;
    }
    if(m.type==='station_state' && m.stationId!==stationId){
      remoteStations.set(m.stationId,m);
      if(m.kind==='virtual' && m.band===band) renderNpcList();
      return;
    }
    if(m.type==='station_left'){
      remoteStations.delete(m.stationId); remoteKeyUp(m.stationId); renderNpcList(); return;
    }
    if(m.type==='activity' && m.message) { log(m.message); return; }
    if(m.type==='cw_frame' && m.stationId!==stationId){ playCwFrame(m); return; }
    if(m.type==='key_down' && m.stationId!==stationId){ remoteKeyDown(m); return; }
    if(m.type==='key_up' && m.stationId!==stationId){ remoteKeyUp(m.stationId); return; }
    if(m.type==='space_weather'){
      const kp=(m.kp===null||m.kp===undefined)?NaN:Number(m.kp), sfi=(m.sfi===null||m.sfi===undefined)?NaN:Number(m.sfi);
      spaceWeather={...spaceWeather,...m,kp:Number.isFinite(kp)?kp:null,sfi:Number.isFinite(sfi)?sfi:null};
      $('#prop').textContent=(spaceWeather.kp==null&&spaceWeather.sfi==null)
        ?'NOAA · UNAVAILABLE'
        :`Kp ${spaceWeather.kp?.toFixed(1)??'–'} · SFI ${spaceWeather.sfi??'–'}`;
      refreshRemoteVoices(); updateNoiseLevel(); scheduleQrn(); scheduleQrm(); scheduleStatic(); scheduleRadioBursts();
      return;
    }
    if(m.type==='qso_complete'){
      qsoCount++;
      $('#qsoStat').textContent=qsoCount;
      log('QSO completed'+(m.with?' with '+m.with:'')+'.');
      return;
    }
    if(m.type==='service_text') return;
  }

  function maidenheadToLatLon(locator){
    const s=String(locator||'').trim().toUpperCase();
    if(!/^[A-R]{2}[0-9]{2}([A-X]{2})?([0-9]{2})?$/.test(s)) return null;
    let lon=-180+(s.charCodeAt(0)-65)*20;
    let lat=-90 +(s.charCodeAt(1)-65)*10;
    let lonSize=20, latSize=10;
    lon+=Number(s[2])*2; lat+=Number(s[3]); lonSize=2; latSize=1;
    if(s.length>=6){
      lon+=(s.charCodeAt(4)-65)/12; lat+=(s.charCodeAt(5)-65)/24;
      lonSize=1/12; latSize=1/24;
    }
    if(s.length>=8){
      lon+=Number(s[6])/120; lat+=Number(s[7])/240;
      lonSize=1/120; latSize=1/240;
    }
    return {lat:lat+latSize/2,lon:lon+lonSize/2};
  }
  function bearingDistanceTo(remoteLocator){
    const a=maidenheadToLatLon($('#locator').value), b=maidenheadToLatLon(remoteLocator);
    if(!a||!b) return null;
    const r=Math.PI/180, p1=a.lat*r, p2=b.lat*r, dl=(b.lon-a.lon)*r;
    const y=Math.sin(dl)*Math.cos(p2);
    const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    const bearing=(Math.atan2(y,x)/r+360)%360;
    const dlat=(b.lat-a.lat)*r;
    const h=Math.sin(dlat/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    const distance=6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
    return {bearing,distance};
  }
  function antennaFactor(st){
    // ANT 2: omnidirectional 1/4-wave vertical.
    if(antenna!==1) return 1;
    const geo=bearingDistanceTo(st.locator);
    if(!geo) return 1;

    // ANT 1: deliberately audible 3-element Yagi pattern.
    // Front ≈ +5 dB, sides heavily attenuated, rear ≈ -16 dB.
    // Continuous interpolation prevents abrupt jumps while the rotor turns.
    const d=Math.abs(shortestDelta(rotorActual,geo.bearing));
    const points=[
      [0,1.78],[20,1.68],[35,1.42],[50,1.05],
      [70,.72],[90,.48],[110,.34],[130,.25],
      [150,.19],[180,.16]
    ];
    for(let i=1;i<points.length;i++){
      if(d<=points[i][0]){
        const [a0,g0]=points[i-1], [a1,g1]=points[i];
        const x=(d-a0)/(a1-a0);
        return g0+(g1-g0)*x;
      }
    }
    return .16;
  }
  function propagationFactor(st){
    const kp=Number.isFinite(spaceWeather.kp)?spaceWeather.kp:2;
    const sfi=Number.isFinite(spaceWeather.sfi)?spaceWeather.sfi:120;
    let f=1;
    if(kp>3) f*=Math.max(.72,1-(kp-3)*.055);
    if(band===10) f*=Math.max(.82,Math.min(1.15,.88+(sfi-90)/320));
    else if(band===15) f*=Math.max(.86,Math.min(1.12,.92+(sfi-90)/420));
    else if(band===20) f*=Math.max(.90,Math.min(1.08,.96+(sfi-90)/600));
    const geo=bearingDistanceTo(st.locator);
    if(geo){
      const d=geo.distance;
      if(d<80) f*=.92;
      else if(d<400) f*=.98;
      else if(d<3500) f*=1.04;
      else if(d>9000) f*=.90;
    }
    return f;
  }
  function signalLevel(st){
    const p=Math.max(1,st.power||10);
    const powerDb=10*Math.log10(p/10);
    const bandBase={40:.28,20:.27,15:.25,10:.23}[band]||.25;
    const seed=((st.stationId||'x').split('').reduce((a,c)=>a+c.charCodeAt(0),0)%17)/110;
    return Math.max(.02,Math.min(.78,(bandBase+seed+powerDb/95)*antennaFactor(st)*propagationFactor(st)));
  }
  function receiveGainFor(st){
    if(st.band!==band) return 0;
    const df=Math.abs((st.hz||0)-hz);
    const capture=filterCaptureHz();
    // Receiver skirts rather than a digital brick wall. You now hear a station
    // rise progressively as the VFO approaches it and fade away past the edge.
    const core=capture*.12;
    const outer=capture*1.48;
    if(df>=outer) return 0;
    let pass=1;
    if(df>core){
      const x=(df-core)/(outer-core);
      pass=.5*(1+Math.cos(Math.PI*x));
      pass=Math.pow(pass,1.18);
    }
    return signalLevel(st)*pass;
  }
  function qsbFactor(v){
    const t=performance.now()/1000;
    return .72+.28*(.5+.5*Math.sin(t*(v.qsbRate||.10)*Math.PI*2+(v.qsbPhase||0)));
  }

  function resetDecoder(){
    for(const d of decoderStates.values()){ clearTimeout(d.charTimer); clearTimeout(d.wordTimer); }
    decoderStates.clear(); decodedText='';
    if($('#decode').classList.contains('active')) $('#decodeTicker').textContent='DATA · Listening…';
  }
  function updateDecodeTicker(){
    if(!$('#decode').classList.contains('active')) return;
    $('#decodeTicker').textContent='DATA · '+(decodedText||'Listening…').slice(-110);
  }
  function decoderState(id,st){
    let d=decoderStates.get(id);
    if(!d){
      d={marks:'',downAt:0,lastUp:0,charTimer:null,wordTimer:null,unit:1200/Math.max(5,st.wpm||15),corrupt:false};
      decoderStates.set(id,d);
    }
    d.unit=1200/Math.max(5,st.wpm||15);
    return d;
  }
  function decoderKeyDown(st){
    if(!$('#decode').classList.contains('active') || receiveGainFor(st)<.018) return;
    const d=decoderState(st.stationId,st);
    clearTimeout(d.charTimer); clearTimeout(d.wordTimer);
    const now=performance.now();
    if(d.lastUp && now-d.lastUp>=d.unit*5.2 && decodedText && !decodedText.endsWith(' ')) decodedText+=' ';
    d.downAt=now;
    let simultaneous=0;
    for(const [id,v] of remoteVoices){
      if(id!==st.stationId && v.down){
        const other=remoteStations.get(id);
        if(other && receiveGainFor(other)>.025) simultaneous++;
      }
    }
    d.corrupt=simultaneous>0;
    updateDecodeTicker();
  }
  function commitDecoderChar(id){
    const d=decoderStates.get(id); if(!d||!d.marks) return;
    decodedText+=d.corrupt?'?':(MORSE_DECODE[d.marks]||'?');
    d.marks=''; d.corrupt=false; updateDecodeTicker();
  }
  function decoderKeyUp(st){
    if(!$('#decode').classList.contains('active')) return;
    const d=decoderStates.get(st.stationId); if(!d||!d.downAt) return;
    const now=performance.now(), dur=now-d.downAt;
    d.downAt=0; d.lastUp=now;
    if(dur<d.unit*.35 || dur>d.unit*5.5) d.corrupt=true;
    d.marks+=dur<d.unit*2?'.':'-';
    clearTimeout(d.charTimer); clearTimeout(d.wordTimer);
    d.charTimer=setTimeout(()=>commitDecoderChar(st.stationId),d.unit*2.15);
    d.wordTimer=setTimeout(()=>{
      commitDecoderChar(st.stationId);
      if(decodedText && !decodedText.endsWith(' ')) decodedText+=' ';
      updateDecodeTicker();
    },d.unit*6.2);
  }

  const cwFramePlaybacks=new Map();
  function stopFramePlayback(id){
    const p=cwFramePlaybacks.get(id);if(!p)return;
    for(const timer of p.timers||[])clearTimeout(timer);
    try{
      const t=audioCtx?.currentTime||0;
      p.markGain?.gain.cancelScheduledValues(t);
      p.markGain?.gain.setValueAtTime(0,t);
      p.tuneGain?.gain.cancelScheduledValues(t);
      p.tuneGain?.gain.setValueAtTime(0,t);
      p.osc?.stop(t+.01);
    }catch{}
    cwFramePlaybacks.delete(id);
    wfKeyUp(id);
  }

  function playCwFrame(m){
    if(!ensureAudio()||!audioCtx||!Array.isArray(m.events))return;
    const st={...(remoteStations.get(m.stationId)||{}),...m,keyDown:false};
    remoteStations.set(m.stationId,st);
    stopFramePlayback(m.stationId);

    const oscF=audioCtx.createOscillator();oscF.type='sine';
    const markGain=audioCtx.createGain();markGain.gain.value=0;
    const tuneGain=audioCtx.createGain();tuneGain.gain.value=0;
    oscF.connect(markGain);markGain.connect(tuneGain);tuneGain.connect(rxMaster);

    const offset=(m.hz||hz)-hz;
    const f=Math.max(160,Math.min(1800,+$('#tone').value+offset));
    oscF.frequency.value=f;

    // Small jitter buffer. The keying envelope is sample-clock accurate.
    // Receiver tuning is a separate continuously adjustable gain stage.
    const lead=.16;
    const t0=audioCtx.currentTime+lead;
    const attack=.0025,release=.0035;
    const timers=[];
    const qsb={qsbRate:.055+Math.random()*.055,qsbPhase:Math.random()*Math.PI*2};
    const initialAmp=Math.max(0,receiveGainFor(st))*qsbFactor(qsb);
    tuneGain.gain.setValueAtTime(initialAmp,t0);

    markGain.gain.cancelScheduledValues(t0);
    markGain.gain.setValueAtTime(0,t0);

    let markOpen=false;
    for(const item of m.events){
      if(!Array.isArray(item)||item.length<2)continue;
      const at=Math.max(0,Number(item[0])||0)/1000;
      const down=!!item[1],tt=t0+at;
      if(down){
        markGain.gain.setValueAtTime(0,tt);
        markGain.gain.linearRampToValueAtTime(1,tt+attack);
      }else{
        markGain.gain.setValueAtTime(1,tt);
        markGain.gain.linearRampToValueAtTime(0,tt+release);
      }

      // Visual waterfall + optional decoder can tolerate ordinary JS timers;
      // the AUDIO itself does not depend on them anymore.
      const timer=setTimeout(()=>{
        if(down){
          wfKeyDown(m.stationId,m.hz,m.kind==='service'?'service':'human');
          decoderKeyDown(st);
        }else{
          wfKeyUp(m.stationId);
          decoderKeyUp(st);
        }
        updateSmeter();
      },Math.max(0,lead*1000+(Number(item[0])||0)));
      timers.push(timer);
    }

    const duration=Math.max(0,Number(m.duration)||0)/1000;
    oscF.start(t0);
    oscF.stop(t0+duration+.08);
    const cleanup=setTimeout(()=>{
      cwFramePlaybacks.delete(m.stationId);
      wfKeyUp(m.stationId);
      updateSmeter();
    },lead*1000+duration*1000+120);
    timers.push(cleanup);
    cwFramePlaybacks.set(m.stationId,{osc:oscF,markGain,tuneGain,qsb,timers,until:performance.now()+lead*1000+duration*1000,st});
  }

  function remoteKeyDown(m){
    ensureAudio();
    const st={...(remoteStations.get(m.stationId)||{}),...m}; remoteStations.set(m.stationId,st);
    const kind=m.kind==='service'?'service':'human';
    wfKeyDown(m.stationId,m.hz,kind);
    let v=remoteVoices.get(m.stationId);
    if(!v){
      const o=audioCtx.createOscillator(); o.type='sine';
      const g=audioCtx.createGain(); g.gain.value=0; o.connect(g); g.connect(rxMaster); o.start();
      v={osc:o,gain:g,down:false,safetyTimer:null,qsbRate:.055+Math.random()*.075,qsbPhase:Math.random()*Math.PI*2}; remoteVoices.set(m.stationId,v);
    }
    v.down=true;
    if(v.safetyTimer) clearTimeout(v.safetyTimer);
    // Network-loss guard: no single CW mark should be able to remain keyed forever.
    v.safetyTimer=setTimeout(()=>{
      if(v.down) remoteKeyUp(m.stationId);
    },2200);
    decoderKeyDown(st);
    const offset=(m.hz||st.hz||hz)-hz;
    const f=Math.max(160,Math.min(1800,+$('#tone').value+offset));
    v.osc.frequency.setTargetAtTime(f,audioCtx.currentTime,.005);
    const amp=receiveGainFor(st)*qsbFactor(v);
    v.gain.gain.cancelScheduledValues(audioCtx.currentTime);
    v.gain.gain.setTargetAtTime(amp,audioCtx.currentTime,.004);
    updateSmeter();
  }
  function remoteKeyUp(id){
    wfKeyUp(id);
    const st=remoteStations.get(id); if(st) decoderKeyUp(st);
    const v=remoteVoices.get(id); if(!v||!audioCtx) return;
    if(v.safetyTimer){ clearTimeout(v.safetyTimer); v.safetyTimer=null; }
    v.down=false; v.gain.gain.cancelScheduledValues(audioCtx.currentTime); v.gain.gain.setTargetAtTime(0,audioCtx.currentTime,.006);
    updateSmeter();
  }
  function refreshRemoteVoices(){
    if(!audioCtx) return;
    const now=audioCtx.currentTime;
    for(const [id,v] of remoteVoices){
      const st=remoteStations.get(id); if(!st||!v.down) continue;
      const offset=(st.hz||hz)-hz;
      v.osc.frequency.setTargetAtTime(Math.max(160,Math.min(1800,+$('#tone').value+offset)),now,.012);
      v.gain.gain.setTargetAtTime(receiveGainFor(st)*qsbFactor(v),now,.075);
    }
    for(const p of cwFramePlaybacks.values()){
      const st=p.st;if(!st||performance.now()>=(p.until||0))continue;
      const offset=(st.hz||hz)-hz;
      p.osc?.frequency.setTargetAtTime(Math.max(160,Math.min(1800,+$('#tone').value+offset)),now,.018);
      const target=Math.max(0,receiveGainFor(st))*qsbFactor(p.qsb||{});
      // Slow receiver/AGC-like response makes tuning through a signal natural.
      p.tuneGain?.gain.setTargetAtTime(target,now,target>(p.tuneGain?.gain.value||0)?.055:.12);
    }
  }
  let smeterAgc=0;
  function updateSmeter(){
    let strongest=0;
    for(const [id,v] of remoteVoices){
      if(!v.down) continue;
      const st=remoteStations.get(id);
      if(st) strongest=Math.max(strongest,receiveGainFor(st));
    }
    for(const p of cwFramePlaybacks.values()){
      if(performance.now()<(p.until||0)&&p.st)strongest=Math.max(strongest,receiveGainFor(p.st));
    }
    const bw=+$('#filter').value;
    const nrOn=$('#nr').classList.contains('active');
    const nbOn=$('#nb').classList.contains('active');
    const baseS={40:4.5,20:3.5,15:2.5,10:1.5}[band]||2.5;
    const bwFactor={600:.76,1800:.92,2500:1}[bw]||1;
    const nrFactor=nrOn?.67:1;
    // Slight live movement makes the floor feel like RF rather than a fixed graphic.
    const flutter=(Math.sin(performance.now()/1350)+Math.sin(performance.now()/730))*0.14;
    const noiseS=Math.max(1,Math.min(9,baseS*bwFactor*nrFactor+flutter));
    const targetS=Math.max(noiseS,Math.min(9,noiseS+strongest*8.2));
    if(rxHoldActive){
      $('#sfill').style.width='3%';
      $('#sigText').textContent='TX';
      return;
    }
    if(!smeterAgc)smeterAgc=noiseS;
    const coeff=targetS>smeterAgc?.30:.075;
    smeterAgc += (targetS-smeterAgc)*coeff;
    if(Math.abs(smeterAgc-noiseS)<.03)smeterAgc=noiseS;
    const displayS=Math.max(1,Math.min(9,Math.round(smeterAgc)));
    $('#sfill').style.width=(6+(smeterAgc/9)*78)+'%';
    $('#sigText').textContent='S'+displayS;
  }
  function startMeter(){ if(meterTimer) return; meterTimer=setInterval(()=>{refreshRemoteVoices();updateSmeter();},120); }

  $('#callsign').addEventListener('change',updateStationDirtyUi);
  $('#locator').addEventListener('change',()=>{updateStationDirtyUi();refreshRemoteVoices();});
  window.addEventListener('beforeunload',()=>{ try{sendNet({type:'leave'});}catch(_){} });

  // -------- Lightweight local usage telemetry placeholders --------
  function fmtDuration(ms,withHours=true){
    let s=Math.floor(ms/1000), h=Math.floor(s/3600); s%=3600;
    let m=Math.floor(s/60); s%=60;
    return withHours ? [h,m,s].map(v=>String(v).padStart(2,'0')).join(':')
                     : [m,s].map(v=>String(v).padStart(2,'0')).join(':');
  }
  function refreshUsage(){
    $('#sessionTime').textContent=fmtDuration(Date.now()-sessionStarted,true);
    const txNow=tx&&txStartMs?Date.now()-txStartMs:0;
    $('#txTimeStat').textContent=fmtDuration(txAccumMs+txNow,false);
    $('#qsoStat').textContent=qsoCount;
  }
  setInterval(refreshUsage,1000);

  function syncLike(){
    $('#likeCount').textContent=likeCount;
    $('#likeBtn').classList.toggle('active',liked);
    $('#likeBtn').firstChild.textContent=liked?'♥ 73 sent · ':'♡ Send 73 / Like · ';
  }
  $('#likeBtn').onclick=()=>{
    if(!liked){ liked=true; likeCount++; }
    else { liked=false; likeCount=Math.max(0,likeCount-1); }
    localStorage.setItem('cwNetLiked',liked?'1':'0');
    localStorage.setItem('cwNetLikeCount',String(likeCount));
    syncLike();
    // SUPABASE HOOK: mp/cw_network like RPC goes here.
  };
  window.addEventListener('error',e=>{
    try{ log('Client error: '+(e.message||'unknown error')); }catch(_){}
    $('#netState').textContent='CLIENT ERROR';
  });
  window.addEventListener('unhandledrejection',e=>{
    try{ log('Client error: '+(e.reason?.message||e.reason||'promise rejection')); }catch(_){}
  });

  $('#activityDetails').classList.add('servicesHidden');
  $('#iambicMode').disabled=true;
  $('#iambicMode').classList.add('disabledCtl');
  syncLike(); updateServiceUI(); renderNpcList(); connectNetwork(); updateNoiseLevel();


})();

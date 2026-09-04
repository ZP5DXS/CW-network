(() => {


  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const bands = {
    80:{base:3.550e6, center:3.555e6, min:3.550e6, max:3.560e6},
    40:{base:7.030e6, center:7.035e6, min:7.030e6, max:7.040e6},
    20:{base:14.025e6,center:14.030e6,min:14.025e6,max:14.035e6},
    15:{base:21.025e6,center:21.030e6,min:21.025e6,max:21.035e6},
    10:{base:28.020e6,center:28.025e6,min:28.020e6,max:28.030e6}
  };
  let band = 40, hz = bands[40].center, tx=false, keyMode='STRAIGHT', antenna=2;
  let audioCtx, osc, gain;
  let lastKeyDown=0;
  let vfoStep=10, vfoFast=false;
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
  const serviceFreqByBand={80:3551500,40:7031500,20:14026500,15:21026500,10:28021500};
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
  let ws=null, reconnectTimer=null, stationId=null, netSeq=0, lastStateSent='';
  let stateSendTimer=null, connectedOnce=false;
  const remoteStations=new Map();
  const remoteVoices=new Map();
  let rxMaster=null, noiseGain=null, noiseSource=null;
  let meterTimer=null;

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
    hz=Math.round(target);
    clampHz();
    redraw();
    scheduleStateSend(true);
    log('Waterfall tune: '+(hz/1e6).toFixed(6)+' MHz.');
  });
  $('#dial').addEventListener('wheel', e=>{
    e.preventDefault();
    const step=vfoStep*(vfoFast?10:1);
    tuneBy(e.deltaY<0?step:-step);
  },{passive:false});

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

  $('#vfoFast').onclick=()=>{
    vfoFast=!vfoFast;
    $('#vfoFast').classList.toggle('active',vfoFast);
    $('#vfoFast').textContent='FAST · '+(vfoFast?'ON':'OFF');
  };
  const steps=[1,10,100,1000];
  $('#vfoStep').onclick=()=>{
    const i=(steps.indexOf(vfoStep)+1)%steps.length;
    vfoStep=steps[i];
    $('#vfoStep').textContent='STEP · '+(vfoStep>=1000?(vfoStep/1000)+' kHz':vfoStep+' Hz');
  };

  $$('#bandButtons button').forEach(btn=>btn.onclick=()=>{
    const nextBand=+btn.dataset.band;
    if(nextBand===band) return;

    $$('#bandButtons button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    band=nextBand; hz=bands[band].center; redraw();
    $('#bandActivity').textContent=band+'M · …';
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
    $('#decodeTicker').textContent=on?'DATA · Listening for readable CW on tuned frequency…':'';
  };
  $('#reverse').onclick=()=>{
    $('#reverse').classList.toggle('active');
    $('#reverse').textContent=$('#reverse').classList.contains('active')?'REVERSED':'NORMAL';
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
  $('#filter').onchange=()=>{ $('#filterText').textContent=$('#filter').value+' Hz'; refreshRemoteVoices(); };
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
    $('#keybar').textContent=keyMode==='STRAIGHT'
      ? 'SPACE / MOUSE · KEY'
      : (iambicMode==='BUG' ? 'PADDLE · BUG' : 'PADDLE · IAMBIC '+iambicMode);

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
      audioCtx=new (window.AudioContext||window.webkitAudioContext)();
      gain=audioCtx.createGain(); gain.gain.value=0;
      rxMaster=audioCtx.createGain(); rxMaster.gain.value=0.55;
      gain.connect(audioCtx.destination);
      rxMaster.connect(audioCtx.destination);
      osc=audioCtx.createOscillator(); osc.type='sine'; osc.frequency.value=+$('#tone').value; osc.connect(gain); osc.start();
      createNoise();
      startMeter();
    }
    if(audioCtx.state==='suspended') audioCtx.resume();
  }

  function createNoise(){
    const length=audioCtx.sampleRate*2;
    const buf=audioCtx.createBuffer(1,length,audioCtx.sampleRate);
    const data=buf.getChannelData(0);
    for(let i=0;i<length;i++) data[i]=(Math.random()*2-1)*0.45;
    noiseSource=audioCtx.createBufferSource(); noiseSource.buffer=buf; noiseSource.loop=true;
    const hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=250;
    const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=1700;
    noiseGain=audioCtx.createGain();
    noiseSource.connect(hp); hp.connect(lp); lp.connect(noiseGain); noiseGain.connect(rxMaster); noiseSource.start();
    updateNoiseLevel();
  }

  function updateNoiseLevel(){
    if(!noiseGain) return;
    const base={80:.055,40:.04,20:.03,15:.025,10:.022}[band]||.03;
    const nr=$('#nr').classList.contains('active')?.55:1;
    const nb=$('#nb').classList.contains('active')?.88:1;
    noiseGain.gain.setTargetAtTime(base*nr*nb,audioCtx.currentTime,.05);
    rxMaster.gain.setTargetAtTime((+$('#afVol').value/100),audioCtx.currentTime,.04);
  }

  function ramp(to,ms=5){
    ensureAudio();
    const t=audioCtx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value,t);
    gain.gain.linearRampToValueAtTime(to,t+ms/1000);
  }
  function keyDown(){
    if(tx) return;
    tx=true; lastKeyDown=performance.now(); txStartMs=Date.now();
    wfKeyDown('LOCAL',hz,'human');
    $('#txFlag').textContent='TX'; $('#txFlag').classList.add('tx');
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
    $('#txFlag').textContent='RX'; $('#txFlag').classList.remove('tx');
    $('#keybar').classList.remove('down');
    $('#keybar').textContent=keyMode==='STRAIGHT'?'SPACE / MOUSE · KEY':(iambicMode==='BUG'?'PADDLE · BUG':'PADDLE · IAMBIC '+iambicMode);
    updateSmeter();
    ramp(0,5);
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

  window.addEventListener('keydown',e=>{
    if(e.code!=='Space') return;
    const editing=document.activeElement && ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName);
    if(!editing) e.preventDefault();
  },{capture:true,passive:false});

  document.addEventListener('keydown',e=>{
    if(e.repeat) return;

    if(e.code==='Space'){
      const editing=document.activeElement && ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName);
      if(!editing){
        e.preventDefault();
        e.stopPropagation();
        if(keyMode==='STRAIGHT') keyDown();
      }
      return;
    }

    if(isDitCode(e)){
      e.preventDefault();
      const ditInput = $('#reverse').classList.contains('active') ? 'dah' : 'dit';
      if(ditInput==='dit') paddleDit=true; else paddleDah=true;
      if(keyMode==='PADDLE'){
        if(iambicMode==='BUG'){
          if(ditInput==='dit') runBugDits();
          else {
            manualDahDown=true;
            cancelKeyer();
            if(!tx) keyDown();
          }
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
          else {
            manualDahDown=true;
            cancelKeyer();
            if(!tx) keyDown();
          }
        } else runKeyer();
      }
    }
  });

  document.addEventListener('keyup',e=>{
    if(e.code==='Space'){
      const editing=document.activeElement && ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName);
      if(!editing){
        e.preventDefault();
        e.stopPropagation();
        if(keyMode==='STRAIGHT') keyUp();
      }
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

  $('#keybar').addEventListener('pointerdown',e=>{
    e.preventDefault();
    $('#keybar').setPointerCapture(e.pointerId);
    keyDown();
  });
  $('#keybar').addEventListener('pointerup',keyUp);
  $('#keybar').addEventListener('pointercancel',keyUp);


  // -------- Realtime-ready waterfall event model --------
  const wfCanvas=$('#wfCanvas');
  const wfCtx=wfCanvas.getContext('2d',{alpha:true});
  let wfLast=performance.now();
  let wfAccum=0;
  const wfScrollPxPerSec=70;

  function resizeWaterfallCanvas(){
    const r=$('#waterfall').getBoundingClientRect();
    const dpr=Math.max(1,window.devicePixelRatio||1);
    const old=document.createElement('canvas');
    old.width=wfCanvas.width; old.height=wfCanvas.height;
    if(old.width&&old.height) old.getContext('2d').drawImage(wfCanvas,0,0);

    wfCanvas.width=Math.max(1,Math.round(r.width*dpr));
    wfCanvas.height=Math.max(1,Math.round(r.height*dpr));
    wfCanvas.style.width=r.width+'px';
    wfCanvas.style.height=r.height+'px';
    wfCtx.setTransform(dpr,0,0,dpr,0,0);
    wfCtx.imageSmoothingEnabled=false;

    if(old.width&&old.height){
      wfCtx.drawImage(old,0,0,old.width,old.height,0,0,r.width,r.height);
    }
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

    const w=wfCanvas.clientWidth;
    const h=wfCanvas.clientHeight;

    if(w>0 && h>0 && wfAccum>=1){
      const dy=Math.floor(wfAccum);
      wfAccum-=dy;

      // Move existing waterfall down as a bitmap: no DOM nodes, no layout churn.
      wfCtx.save();
      wfCtx.globalCompositeOperation='copy';
      wfCtx.drawImage(wfCanvas,0,0,w,h-dy,0,dy,w,h-dy);
      wfCtx.restore();
      wfCtx.clearRect(0,0,w,dy);
    }

    // Draw only the current keyed state at the top edge.
    // Service frequencies are reserved visually: suppress green traces under the amber service.
    const traces=[...activeTraces.values()].sort((a,b)=>(a.kind==='service')-(b.kind==='service'));
    traces.forEach(t=>{
      if(t.kind!=='service' && isNearServiceFreq(t.freq)) return;
      const x=freqToX(t.freq);
      if(x<0 || x>w) return;
      wfCtx.fillStyle=wfColor(t.kind);
      const traceW=t.kind==='service'?7:3;
      const traceH=t.kind==='service'?4:3;
      wfCtx.fillRect(Math.round(x)-traceW/2,0,traceW,traceH);
    });

    requestAnimationFrame(scrollWaterfall);
  }
  requestAnimationFrame(scrollWaterfall);

  // -------- Network services display --------
  function updateServiceUI(){ return serviceFreqByBand[band]; }
  function renderNpcList(){
    const services=[{label:'NETWORK INFO',freq:serviceFreqByBand[band]}];
    $('#npcList').innerHTML=services.map(s=>
      `<div class="bandnpc"><b>${(s.freq/1e6).toFixed(6)} MHz</b><span>${s.label}</span></div>`
    ).join('');
  }
  $('#activityDetailsToggle').onchange=()=>{
    $('#activityDetails').classList.toggle('servicesHidden',!$('#activityDetailsToggle').checked);
  };

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
  function connectNetwork(){
    clearTimeout(reconnectTimer);
    $('#netState').textContent=connectedOnce?'RECONNECTING':'CONNECTING';
    try{ ws=new WebSocket(WS_URL); }catch(e){ return scheduleReconnect(); }
    ws.onopen=()=>{
      connectedOnce=true; $('#netState').textContent='ONLINE'; log('Network connected.');
      lastStateSent=''; scheduleStateSend(true);
    };
    ws.onclose=()=>{ $('#netState').textContent='RECONNECTING'; log('Network connection lost. Reconnecting…'); scheduleReconnect(); };
    ws.onerror=()=>{};
    ws.onmessage=e=>{ try{ handleNet(JSON.parse(e.data)); }catch(_){} };
  }
  function scheduleReconnect(){ clearTimeout(reconnectTimer); reconnectTimer=setTimeout(connectNetwork,2500); }

  function handleNet(m){
    if(m.type==='welcome'){ stationId=m.stationId||stationId; return; }
    if(m.type==='presence'){
      $('#onlineUsers').textContent=m.online??0;
      if(m.activity && m.activity[band]) $('#bandActivity').textContent=band+'M · '+m.activity[band];
      return;
    }
    if(m.type==='snapshot'){
      (m.stations||[]).forEach(s=>remoteStations.set(s.stationId,s));
      return;
    }
    if(m.type==='station_state' && m.stationId!==stationId){ remoteStations.set(m.stationId,m); return; }
    if(m.type==='station_left'){
      remoteStations.delete(m.stationId); remoteKeyUp(m.stationId); return;
    }
    if(m.type==='activity' && m.message) { log(m.message); return; }
    if(m.type==='key_down' && m.stationId!==stationId){ remoteKeyDown(m); return; }
    if(m.type==='key_up' && m.stationId!==stationId){ remoteKeyUp(m.stationId); return; }
    if(m.type==='service_text' && $('#decode').classList.contains('active') && m.band===band){
      if(Math.abs(hz-m.hz)<=Math.max(250,+$('#filter').value/2)) $('#decodeTicker').textContent='DATA · '+m.text;
    }
  }

  function bearingApprox(locator){
    if(!locator || locator.length<4) return null;
    // Deterministic fallback bearing for the virtual RF engine until full Maidenhead geodesy is added.
    let h=0; for(const c of locator) h=(h*31+c.charCodeAt(0))>>>0; return h%360;
  }
  function antennaFactor(st){
    if(antenna!==1 || !$('#locator').value || !st.locator) return 1;
    const br=bearingApprox(st.locator); if(br==null) return 1;
    const d=Math.abs(shortestDelta(rotorActual,br));
    if(d<=35) return 1.6;
    if(d<=75) return 1.05;
    if(d<=120) return .65;
    return .42;
  }
  function signalLevel(st){
    const p=Math.max(1,st.power||10);
    const powerDb=10*Math.log10(p/10);
    const bandBase={80:.22,40:.25,20:.24,15:.22,10:.20}[band]||.22;
    const seed=((st.stationId||'x').split('').reduce((a,c)=>a+c.charCodeAt(0),0)%17)/100;
    return Math.max(.025,Math.min(.72,(bandBase+seed+powerDb/100)*antennaFactor(st)));
  }
  function receiveGainFor(st){
    if(st.band!==band) return 0;
    const df=Math.abs((st.hz||0)-hz);
    const bw=+$('#filter').value;
    const edge=bw/2;
    if(df>edge*1.35) return 0;
    const pass=df<=edge?1:Math.max(0,1-(df-edge)/(edge*.35));
    return signalLevel(st)*pass*(+$('#afVol').value/100);
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
      v={osc:o,gain:g,down:false,qsb:0}; remoteVoices.set(m.stationId,v);
    }
    v.down=true; v.qsb=.86+Math.random()*.22;
    const offset=(m.hz||st.hz||hz)-hz;
    const f=Math.max(160,Math.min(1800,+$('#tone').value+offset));
    v.osc.frequency.setTargetAtTime(f,audioCtx.currentTime,.005);
    const amp=receiveGainFor(st)*v.qsb;
    v.gain.gain.cancelScheduledValues(audioCtx.currentTime);
    v.gain.gain.setTargetAtTime(amp,audioCtx.currentTime,.004);
    updateSmeter();
  }
  function remoteKeyUp(id){
    wfKeyUp(id);
    const v=remoteVoices.get(id); if(!v||!audioCtx) return;
    v.down=false; v.gain.gain.cancelScheduledValues(audioCtx.currentTime); v.gain.gain.setTargetAtTime(0,audioCtx.currentTime,.006);
    updateSmeter();
  }
  function refreshRemoteVoices(){
    if(!audioCtx) return;
    for(const [id,v] of remoteVoices){
      const st=remoteStations.get(id); if(!st||!v.down) continue;
      const offset=(st.hz||hz)-hz;
      v.osc.frequency.setTargetAtTime(Math.max(160,Math.min(1800,+$('#tone').value+offset)),audioCtx.currentTime,.006);
      v.gain.gain.setTargetAtTime(receiveGainFor(st)*(v.qsb||1),audioCtx.currentTime,.02);
    }
  }
  function updateSmeter(){
    let strongest=0;
    for(const [id,v] of remoteVoices){ if(!v.down) continue; const st=remoteStations.get(id); if(st) strongest=Math.max(strongest,receiveGainFor(st)); }
    const noise={80:.10,40:.075,20:.055,15:.045,10:.04}[band]||.05;
    const level=Math.min(1,noise+strongest);
    $('#sfill').style.width=(4+level*92)+'%';
    const s=Math.max(1,Math.min(9,Math.round(level*10)));
    $('#sigText').textContent=strongest>.02?'S'+s:'S'+Math.max(1,Math.round(noise*10));
  }
  function startMeter(){ if(meterTimer) return; meterTimer=setInterval(updateSmeter,140); }

  $('#callsign').addEventListener('change',()=>scheduleStateSend(true));
  $('#locator').addEventListener('change',()=>scheduleStateSend(true));
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
  $('#activityDetails').classList.add('servicesHidden');
  $('#iambicMode').disabled=true;
  $('#iambicMode').classList.add('disabledCtl');
  syncLike(); updateServiceUI(); renderNpcList(); connectNetwork(); updateNoiseLevel();


})();

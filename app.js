
let socket=null, timer=null;
const meta={home:['Overview','KNX control'],lighting:['Lighting',''],av:['Audio & Video','Entertainment'],climate:['Climate','Temperatuur en ventilatie'],rooms:['Rooms','Bediening per kamer'],scenes:['Scenes','Favorieten en automatisering'],energy:['Energy','Verbruik en productie'],settings:['Settings','KNX/IP verbinding en groepsadressen']};
function page(id,b){closeSidebar();document.querySelectorAll('.page').forEach(x=>{x.classList.remove('active');x.style.display='none'});const target=document.getElementById(id);if(!target)return;target.classList.add('active');target.style.display='block';document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));if(b)b.classList.add('active');document.getElementById('title').textContent=meta[id][0];document.getElementById('sub').textContent=meta[id][1];if(id==='settings'){renderRoomConfigs();renderSliderConfigs()}if(id==='lighting')renderLightingSliders()}
let knxUiState='offline';
const logBuffer=[];
function log(s,cls=''){
  const entry={time:new Date().toLocaleTimeString(),text:String(s),cls};
  logBuffer.push(entry);
  if(logBuffer.length>80)logBuffer.shift();
  renderCommunicationLog();
}
function renderCommunicationLog(){
  const l=document.getElementById('log');
  if(!l)return;
  l.innerHTML=logBuffer.map(e=>`<div class="${e.cls}">[${e.time}] ${esc(e.text)}</div>`).join('');
  l.scrollTop=l.scrollHeight;
}
function updateKnxUi(connected,message,source='server'){
  knxUiState=connected?'connected':'offline';
  const ks=document.getElementById('knxState'); if(ks)ks.textContent=connected?'online':'offline';
  const hk=document.getElementById('homeKnx'); if(hk)hk.textContent=connected?'Connected':'Not connected';
  const sb=document.getElementById('sidebarKnxStatus');
  if(sb){sb.textContent=connected?'● KNX connected':'● KNX offline';sb.className='sidebar-status '+(connected?'online':'offline');}
  if(message)log(message,connected?'ok':'err');
}

function toast(s){const t=document.getElementById('toast');t.textContent=s;t.style.display='block';clearTimeout(timer);timer=setTimeout(()=>t.style.display='none',2000)}
function connectSocket(){
 if(location.protocol==='file:'){
   document.getElementById('ws').textContent='open via http://smarthome.local:3010';
   document.getElementById('ws').className='err';
   log('Open dit dashboard via http://smarthome.local:3010 — niet door index.html dubbel te klikken.','err');
   return;
 }
 if(!location.host){
   document.getElementById('ws').textContent='geen host';
   document.getElementById('ws').className='err';
   return;
 }
 socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
 socket.onopen=()=>{log('WebSocket verbonden','ok')};
 socket.onclose=()=>{log('Dashboard connection lost — reconnecting…','err');clearTimeout(window.wsRetry);window.wsRetry=setTimeout(connectSocket,3000)};
 socket.onerror=()=>{log('WebSocket niet bereikbaar. Controleer of de server draait.','err')};
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='knx-status'){const ks=document.getElementById('knxState');if(ks)ks.textContent=m.connected?'online':'offline';const hk=document.getElementById('homeKnx');if(hk)hk.textContent=m.connected?'Connected':'Not connected';const sb=document.getElementById('sidebarKnxStatus');if(sb){sb.textContent=m.connected?'● KNX connected':'● KNX offline';sb.className='sidebar-status '+(m.connected?'online':'offline')}log(m.message,m.connected?'ok':'err')}
 if(m.type==='feedback'){
   const v=Math.max(0,Math.min(100,Number(m.value)));
   const ga=String(m.ga||'').trim();
   const arr=sliders();
   let sx=arr.find(x=>String(x.feedbackGa||'').trim()===ga);
   let rgbIndex=-1;
   if(!sx){
     sx=arr.find(x=>x.mode==='rgbw' && x.rgbw && Array.isArray(x.rgbw.feedback) && (rgbIndex=x.rgbw.feedback.findIndex(g=>String(g||'').trim()===ga))>=0);
   }
   if(sx){
     if(sx.mode==='rgbw' && rgbIndex>=0){
       sx.feedbackRGBW=sx.feedbackRGBW||[null,null,null,null]; sx.feedbackRGBW[rgbIndex]=v;
       const el=document.getElementById('rgbw-slider-'+sx.id); if(el){el.value=rgbwPositionFromValues(sx.feedbackRGBW)}
       const bright=rgbwBrightnessFromValues(sx.feedbackRGBW), warm=Number(sx.feedbackRGBW[3]??0);
       const bs=document.getElementById('rgbw-bright-slider-'+sx.id), ws=document.getElementById('rgbw-warm-slider-'+sx.id);
       if(bs)bs.value=bright;if(ws)ws.value=warm;
       updateRGBWPreview(sx.id,sx.feedbackRGBW);
       const sw=document.getElementById('rgbw-swatch-'+sx.id); if(sw)sw.style.background=rgbwColorFromValues(sx.feedbackRGBW);
     }else{
       sx.feedbackValue=v;
       const lb=document.getElementById('cfgval-'+sx.id);const lv=document.getElementById('light-val-'+sx.id);const sl=document.getElementById('light-slider-'+sx.id);const prev=document.getElementById('preview-slider-'+sx.id);
       if(lb)lb.textContent=v+'%';if(lv)lv.textContent=v+'%';if(sl){sl.value=v;sl.style.setProperty('--fill',v+'%')}if(prev){prev.value=v;prev.style.setProperty('--fill',v+'%')}
     }
     saveSliders(arr);
   }
   const homeFb=document.getElementById('homeFb');if(homeFb)homeFb.textContent=v+'%';const homeSlider=document.getElementById('homeSlider');if(homeSlider)homeSlider.value=v;const homeLight=document.getElementById('homeLight');if(homeLight)homeLight.textContent=v;log(`Feedback ${ga} = ${v}%`,'ok');
 }
 }
}
function send(o){if(socket&&socket.readyState===1)socket.send(JSON.stringify(o));else toast('Geen serververbinding')}
function sliders(){try{const a=JSON.parse(localStorage.getItem('knxSliders')||'null');return Array.isArray(a)?a:[{id:'w1',name:'Woonkamer',room:'Woonkamer',mode:'dim',writeGa:'1/1/69',feedbackGa:'2/1/69',value:70,feedbackValue:null,rgbw:{write:['','','',''],feedback:['','','','']}}]}catch(e){return []}}
function saveSliders(a){localStorage.setItem('knxSliders',JSON.stringify(a)); syncSharedStateDebounced()}
function normalizeSliders(){const a=sliders().map(x=>({...x,room:x.room||'Woonkamer',mode:x.mode==='rgbw'?'rgbw':'dim',rgbw:x.rgbw||{write:['','','',''],feedback:['','','','']}}));saveSliders(a);return a}
function gaOK(v){return /^\d{1,3}\/\d{1,3}\/\d{1,3}$/.test(v)}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

const DEFAULT_ROOMS=['Woonkamer','Keuken','Eetkamer','Slaapkamer','Kantoor','Badkamer','Hal','Overig'];
function rooms(){try{return JSON.parse(localStorage.getItem('knxRooms')||'null')||DEFAULT_ROOMS.slice()}catch(e){return DEFAULT_ROOMS.slice()}}
function saveRooms(a){localStorage.setItem('knxRooms',JSON.stringify(a)); syncSharedStateDebounced()}
function normalizeRooms(){const a=rooms().map(String).map(x=>x.trim()).filter(Boolean);const unique=[...new Set(a)];if(!unique.length)unique.push(...DEFAULT_ROOMS);saveRooms(unique);return unique}
function roomOptions(selected){const rs=rooms();const active=rs.includes(selected)?selected:(rs[0]||'');return rs.map(r=>'<option '+(r===active?'selected ':'')+'value="'+esc(r)+'">'+esc(r)+'</option>').join('')}
let lightingRoom='all';
function availableRooms(){
 // Toon alle aangemaakte ruimtes, ook als er nog geen slider aan gekoppeld is.
 return rooms();
}
function renderRoomFilter(){
 const sel=document.getElementById('lightingRoomFilter');
 if(!sel)return;
 const rooms=availableRooms();
 if(lightingRoom!=='all'&&!rooms.includes(lightingRoom)) lightingRoom=rooms[0]||'all';
 sel.innerHTML='<option value="all">Alle ruimtes</option>'+rooms.map(r=>'<option value="'+esc(r)+'">'+esc(r)+'</option>').join('');
 sel.value=lightingRoom;
 const count=document.getElementById('roomCount');
 const total=sliders().filter(x=>lightingRoom==='all'||(x.room||'Woonkamer')===lightingRoom).length;
 if(count)count.textContent=total+' slider'+(total===1?'':'s');
}
function setLightingRoom(v){lightingRoom=v;renderLightingSliders()}
function toggleSidebar(){document.querySelector('aside').classList.toggle('open');document.getElementById('sidebarBackdrop').classList.toggle('show')}
function closeSidebar(){document.querySelector('aside').classList.remove('open');document.getElementById('sidebarBackdrop').classList.remove('show')}
function renderRoomConfigs(){
 const box=document.getElementById('roomConfigList');if(!box)return;
 const rs=normalizeRooms();box.innerHTML='';
 rs.forEach(r=>{
   const count=sliders().filter(x=>(x.room||'Woonkamer')===r).length;
   const d=document.createElement('div');d.className='device';
   d.innerHTML='<div class="row" style="padding:0;border:0"><span><b>'+esc(r)+'</b><br><small class="muted">'+count+' slider'+(count===1?'':'s')+'</small></span><button class="btn danger room-remove">Verwijder</button></div>';
   const btn=d.querySelector('.room-remove');
   if(count>0){btn.disabled=true;btn.title='Verplaats eerst de sliders uit deze ruimte';}
   btn.addEventListener('click',()=>removeRoom(r));
   box.appendChild(d);
 });
}

function addRoom(){
 const input=document.getElementById('newRoomName');
 const clean=(input?.value||'').trim();
 if(!clean){toast('Vul een naam in');return;}
 const rs=rooms();if(rs.some(r=>r.toLowerCase()===clean.toLowerCase())){toast('Deze ruimte bestaat al');return}
 rs.push(clean);saveRooms(rs);if(input)input.value='';renderRoomConfigs();renderSliderConfigs();renderLightingSliders();toast('Ruimte toegevoegd');
}
function removeRoom(name){
 const rs=rooms();
 if(rs.length<=1){toast('Minimaal één ruimte is nodig');return}
 const used=sliders().some(x=>(x.room||'Woonkamer')===name);
 if(used){toast('Verplaats eerst de sliders uit '+name);return}
 saveRooms(rs.filter(r=>r!==name));
 if(lightingRoom===name)lightingRoom='all';
 renderRoomConfigs();renderSliderConfigs();renderLightingSliders();toast('Ruimte verwijderd');
}
function renderSliderConfigs(){
 const box=document.getElementById('sliderConfigList');if(!box)return;
 const arr=normalizeSliders();box.innerHTML='';
 arr.forEach(x=>{
  x.mode=x.mode==='rgbw'?'rgbw':'dim';
  if(!x.rgbw)x.rgbw={write:['','','',''],feedback:['','','','']};
  const d=document.createElement('div');d.className='slider-config';
  const rgb=x.rgbw;
  const rgbFields=['Rood','Groen','Blauw','Wit'];
  let addrHtml='';
  if(x.mode==='dim'){
    addrHtml='<div><label>Write groepsadres</label><input class="knx" data-k="writeGa" value="'+esc(x.writeGa||'')+'"></div>'+
             '<div><label>Feedback groepsadres</label><input class="knx" data-k="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div>';
  }else{
    addrHtml='<div class="s12" style="grid-column:1/-1"><div class="muted" style="margin-bottom:8px">RGBW groepsadressen — Rood / Groen / Blauw / Wit</div><div class="settings-grid">'+rgbFields.map((n,i)=>'<div><label>'+n+' write</label><input class="knx" data-rgb-write="'+i+'" value="'+esc(rgb.write[i]||'')+'"></div>').join('')+'</div><div class="settings-grid" style="margin-top:8px">'+rgbFields.map((n,i)=>'<div><label>'+n+' feedback</label><input class="knx" data-rgb-feedback="'+i+'" value="'+esc(rgb.feedback[i]||'')+'"></div>').join('')+'</div></div>';
  }
  d.innerHTML='<div class="slider-config-grid" style="grid-template-columns:1.2fr 1fr 1fr auto">'+
   '<div><label>Naam</label><input data-k="name" value="'+esc(x.name)+'"></div>'+
   '<div><label>Ruimte</label><select data-k="room">'+roomOptions(x.room)+'</select></div>'+
   '<div><label>Type</label><select data-k="mode"><option value="dim" '+(x.mode==='dim'?'selected':'')+'>Dim</option><option value="rgbw" '+(x.mode==='rgbw'?'selected':'')+'>RGBW</option></select></div>'+
   '<button class="btn danger" onclick="removeSlider(\''+x.id+'\')">Verwijder</button></div>'+
   '<div style="margin-top:12px">'+addrHtml+'</div>'+
   '<div class="slider-preview"><b>'+esc(x.name)+'</b><input id="preview-slider-'+x.id+'" style="--fill:'+Number(x.value||0)+'%;flex:1" type="range" min="0" max="100" value="'+Number(x.value||0)+'" oninput="sliderPreview(\''+x.id+'\',this.value)"><b id="cfgval-'+x.id+'">'+Number(x.feedbackValue??x.value??0)+'%</b><span class="mode-pill">'+(x.mode==='rgbw'?'RGBW':'Dim')+'</span></div>';
  d.querySelectorAll('[data-k]').forEach(el=>el.addEventListener('change',()=>{
   const aa=sliders(),q=aa.find(z=>z.id===x.id);if(!q)return;
   if(el.dataset.k==='mode'){q.mode=el.value;q.rgbw=q.rgbw||{write:['','','',''],feedback:['','','','']};saveSliders(aa);renderSliderConfigs();renderLightingSliders();return}
   q[el.dataset.k]=el.value;saveSliders(aa);renderRoomConfigs();renderSliderConfigs();renderLightingSliders();toast('Slider opgeslagen');
  }));
  d.querySelectorAll('[data-rgb-write],[data-rgb-feedback]').forEach(el=>el.addEventListener('change',()=>{
    const aa=sliders(),q=aa.find(z=>z.id===x.id);if(!q)return; q.rgbw=q.rgbw||{write:['','','',''],feedback:['','','','']};
    const i=Number(el.dataset.rgbWrite??el.dataset.rgbFeedback); const key=el.dataset.rgbWrite!==undefined?'write':'feedback';
    if(!gaOK(el.value)){toast('Gebruik bijvoorbeeld 1/1/69');return}
    q.rgbw[key][i]=el.value; saveSliders(aa); renderLightingSliders(); toast('RGBW-adres opgeslagen');
  }));
  box.appendChild(d);
 });
}
function renderLightingSliders(){
 const box=document.getElementById('lightingSliders');if(!box)return;
 renderRoomFilter();
 const arr=sliders().filter(x=>lightingRoom==='all'||(x.room||'Woonkamer')===lightingRoom);
 box.innerHTML='';
 if(!arr.length){box.innerHTML='<div class="muted" style="padding:20px 4px">Geen verlichting in deze ruimte.</div>';return}
 arr.forEach(x=>{
  if(x.mode==='rgbw'){
   x.rgbw=x.rgbw||{write:['','','',''],feedback:['','','','']};
   const vals=x.feedbackRGBW||[null,null,null,null];
   const pos=rgbwPositionFromValues(vals);
   const color=rgbwColorFromValues(vals);
   const brightness=rgbwBrightnessFromValues(vals);
   const warm=Number(vals[3]??0);
   const d=document.createElement('div');d.className='rgbw-control';
   d.innerHTML='<div class="rgbw-top"><b>'+esc(x.name)+'</b><span class="rgbw-status-dot" id="rgbw-status-'+x.id+'" style="background:'+color+'" title="RGBW status"></span></div>'+
     '<input class="rgbw-color-slider" id="rgbw-slider-'+x.id+'" type="range" min="0" max="100" value="'+pos+'" oninput="previewRGBW(\''+x.id+'\')">'+
     '<div class="rgbw-secondary"><div><label>Helderheid <b id="rgbw-bval-'+x.id+'">'+brightness+'%</b></label><input id="rgbw-bright-slider-'+x.id+'" type="range" min="0" max="100" value="'+brightness+'" oninput="previewRGBW(\''+x.id+'\')"></div><div><label>Warm wit <b id="rgbw-wval-'+x.id+'">'+warm+'%</b></label><input id="rgbw-warm-slider-'+x.id+'" type="range" min="0" max="100" value="'+warm+'" oninput="previewRGBW(\''+x.id+'\')"></div></div>'+
     '<div class="rgbw-presets" id="rgbw-presets-'+x.id+'"></div>';
   box.appendChild(d);
   renderRGBWPresets(x.id);
  }else{
   const fb=(x.feedbackValue===undefined||x.feedbackValue===null)?'—':Number(x.feedbackValue)+'%';
   const d=document.createElement('div');d.className='lighting-control';
   d.innerHTML='<div class="topline"><b>'+esc(x.name)+'</b><b id="light-val-'+x.id+'">'+fb+'</b></div><div class="range-wrap"><input id="light-slider-'+x.id+'" style="--fill:'+Number(x.value||0)+'%;" type="range" min="0" max="100" value="'+Number(x.value||0)+'" oninput="sendSlider(\''+x.id+'\',this.value)"></div>';
   box.appendChild(d);
  }
 });
}
function addSlider(){
 const a=sliders(),n=a.length+1,g=68+n;
 a.push({id:'s'+Date.now(),name:'Nieuwe slider '+n,room:rooms()[0]||'Overig',mode:'dim',writeGa:'1/1/'+g,feedbackGa:'2/1/'+g,value:0,feedbackValue:null,rgbw:{write:['','','',''],feedback:['','','','']}});
 saveSliders(a);renderSliderConfigs();renderLightingSliders();toast('Nieuwe slider toegevoegd');
}
function removeSlider(id){saveSliders(sliders().filter(x=>x.id!==id));renderSliderConfigs();renderLightingSliders();toast('Slider verwijderd')}
function updateSliderValue(id,v){const a=sliders(),x=a.find(z=>z.id===id);if(x){x.value=Number(v);saveSliders(a)}}
function sendSlider(id,v){
 const x=sliders().find(z=>z.id===id);if(!x||x.mode==='rgbw')return;
 updateSliderValue(id,v); const sl=document.getElementById('light-slider-'+id);if(sl)sl.style.setProperty('--fill',Number(v)+'%');
 send({type:'knx-write',ga:String(x.writeGa).trim(),dpt:'5.001',value:Number(v)});
}
function hueToRgb(h){const s=1,l=.5;const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;let r=0,g=0,b=0;if(h<60){r=c;g=x}else if(h<120){r=x;g=c}else if(h<180){g=c;b=x}else if(h<240){g=x;b=c}else if(h<300){r=x;b=c}else{r=c;b=x}return [Math.round((r+m)*100),Math.round((g+m)*100),Math.round((b+m)*100)]}
function rgbwFromPosition(pos){pos=Number(pos);if(pos<=8||pos>=92)return pos<=8?[0,0,0,100]:[0,0,0,100];const hue=((pos-8)/84)*360;return [...hueToRgb(hue),0]}
function rgbwPositionFromValues(vals){const a=(vals||[]).map(v=>Number(v??0));if(a.every(v=>!v))return 8;const w=a[3]||0;if(w>=85)return 0;const r=Math.max(0,a[0]-w),g=Math.max(0,a[1]-w),b=Math.max(0,a[2]-w);const mx=Math.max(r,g,b),mn=Math.min(r,g,b);if(mx===0)return 0;let h;if(mx===r)h=60*(((g-b)/(mx-mn||1))%6);else if(mx===g)h=60*((b-r)/(mx-mn||1)+2);else h=60*((r-g)/(mx-mn||1)+4);if(h<0)h+=360;return Math.round(8+(h/360)*84)}
function rgbwColorFromValues(vals){const a=(vals||[]).map(v=>Number(v??0));const w=a[3]||0;const r=Math.min(255,Math.round((Math.max(0,a[0]-w)/100)*255+(w/100)*255));const g=Math.min(255,Math.round((Math.max(0,a[1]-w)/100)*255+(w/100)*255));const b=Math.min(255,Math.round((Math.max(0,a[2]-w)/100)*255+(w/100)*255));return 'rgb('+r+','+g+','+b+')'}
function rgbwBrightnessFromValues(vals){const a=(vals||[]).map(v=>Number(v??0));return Math.round(Math.max(a[0]||0,a[1]||0,a[2]||0));}
function rgbwCurrentValues(id){const x=sliders().find(z=>z.id===id);if(!x)return [0,0,0,0];const fb=x.feedbackRGBW||[0,0,0,0];const posEl=document.getElementById('rgbw-slider-'+id);const bEl=document.getElementById('rgbw-bright-slider-'+id);const wEl=document.getElementById('rgbw-warm-slider-'+id);const pos=Number(posEl?.value ?? rgbwPositionFromValues(fb));const b=Number(bEl?.value ?? rgbwBrightnessFromValues(fb));const w=Number(wEl?.value ?? Number(fb[3]??0));const base=rgbwFromPosition(pos);return [Math.round(base[0]*b/100),Math.round(base[1]*b/100),Math.round(base[2]*b/100),Math.round(w)];}
function updateRGBWPreview(id,values){const sw=document.getElementById('rgbw-status-'+id);if(sw)sw.style.background=rgbwColorFromValues(values);const b=rgbwBrightnessFromValues(values),w=Number(values[3]||0);const bv=document.getElementById('rgbw-bval-'+id),wv=document.getElementById('rgbw-wval-'+id);if(bv)bv.textContent=b+'%';if(wv)wv.textContent=w+'%';}
function sendRGBWValues(id,values){const x=sliders().find(z=>z.id===id);if(!x||x.mode!=='rgbw')return;x.rgbw=x.rgbw||{write:['','','',''],feedback:['','','','']};const channels=values.map((v,i)=>({ga:String(x.rgbw.write[i]||'').trim(),value:Math.max(0,Math.min(100,Math.round(Number(v))))})).filter(c=>c.ga&&gaOK(c.ga));if(channels.length)send({type:'knx-write-rgbw',channels});x.value=Number(document.getElementById('rgbw-slider-'+id)?.value||0);}
function previewRGBW(id){const values=rgbwCurrentValues(id);updateRGBWPreview(id,values);sendRGBWValues(id,values);}
function sendRGBWColor(id,pos){previewRGBW(id);}
function rgbwPresets(){try{return JSON.parse(localStorage.getItem('knxRGBWPresets')||'{}')||{}}catch(e){return {}}}
function saveRGBWPresets(o){localStorage.setItem('knxRGBWPresets',JSON.stringify(o));syncSharedStateDebounced()}
function renderRGBWPresets(id){const box=document.getElementById('rgbw-presets-'+id);if(!box)return;const list=rgbwPresets()[id]||[];box.innerHTML='<button class="preset-dot preset-add" title="Huidige kleur opslaan" onclick="saveRGBWPreset(\''+id+'\')">+</button>'+list.map((p,i)=>'<button class="preset-dot" title="Preset '+(i+1)+' toepassen" style="background:'+esc(p.color||'rgb(255,255,255)')+'" onclick="applyRGBWPreset(\''+id+'\','+i+')"></button>').join('')}
function saveRGBWPreset(id){const all=rgbwPresets();const list=all[id]||[];const pos=Number(document.getElementById('rgbw-slider-'+id)?.value||0),brightness=Number(document.getElementById('rgbw-bright-slider-'+id)?.value||0),warm=Number(document.getElementById('rgbw-warm-slider-'+id)?.value||0);const color=rgbwColorFromValues(rgbwCurrentValues(id));list.push({pos,brightness,warm,color});all[id]=list.slice(-12);saveRGBWPresets(all);renderRGBWPresets(id);toast('Kleurpreset opgeslagen')}
function applyRGBWPreset(id,index){const p=(rgbwPresets()[id]||[])[Number(index)];if(!p)return;const cs=document.getElementById('rgbw-slider-'+id),bs=document.getElementById('rgbw-bright-slider-'+id),ws=document.getElementById('rgbw-warm-slider-'+id);if(cs)cs.value=p.pos;if(bs)bs.value=p.brightness;if(ws)ws.value=p.warm;previewRGBW(id);toast('Preset toegepast')}
function sliderPreview(id,v){updateSliderValue(id,v);const lab=document.getElementById('cfgval-'+id);if(lab)lab.textContent=v+'%';const prev=document.getElementById('preview-slider-'+id);if(prev)prev.style.setProperty('--fill',v+'%');const x=sliders().find(z=>z.id===id);if(x&&x.mode==='dim')send({type:'knx-write',ga:String(x.writeGa).trim(),dpt:'5.001',value:Number(v)})}
function setLight(v){
 const x=sliders()[0];if(x)sendSlider(x.id,v);
}
function saveConnection(){localStorage.setItem('knxConnection',JSON.stringify({ip:ip.value,port:port.value,mode:mode.value,phys:phys.value}));toast('KNX-instellingen opgeslagen')}
function loadConnection(){try{const x=JSON.parse(localStorage.getItem('knxConnection')||'{}');if(x.ip)ip.value=x.ip;if(x.port)port.value=x.port;if(x.mode)mode.value=x.mode;if(x.phys)phys.value=x.phys}catch(e){}}
function pageById(id){document.querySelectorAll('.page').forEach(x=>{x.classList.remove('active');x.style.display='none'});const p=document.getElementById(id);if(!p)return;p.classList.add('active');p.style.display='block';document.getElementById('title').textContent=meta[id][0];document.getElementById('sub').textContent=meta[id][1];document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));const b=[...document.querySelectorAll('nav button')].find(x=>(x.getAttribute('onclick')||'').includes("page('' + id + ')"));if(b)b.classList.add('active');if(id==='settings'){renderRoomConfigs();renderSliderConfigs()}if(id==='lighting')renderLightingSliders()}
function applySharedState(state){
 if(!state)return;
 if(Array.isArray(state.rooms)) localStorage.setItem('knxRooms',JSON.stringify(state.rooms));
 if(Array.isArray(state.sliders)) localStorage.setItem('knxSliders',JSON.stringify(state.sliders));
 if(state.presets && typeof state.presets==='object') localStorage.setItem('knxRGBWPresets',JSON.stringify(state.presets));
 renderRoomConfigs();renderSliderConfigs();renderLightingSliders();
}
let lastSharedSignature='';
function sharedSignature(state){
 try{return JSON.stringify({rooms:state?.rooms||[],sliders:state?.sliders||[],presets:state?.presets||{}});}catch(e){return ''}
}
async function syncSharedState(){
 try{
  const r=await fetch('/api/state',{cache:'no-store'});
  if(!r.ok)throw new Error('state '+r.status);
  const state=await r.json();
  const sig=sharedSignature(state);
  const active=document.activeElement;
  const editing=!!(active && (active.matches('input,select,textarea') || active.isContentEditable));
  // Do not rebuild the DOM while an input/select is focused. The previous
  // 2-second refresh replaced the field under the user's finger.
  if(sig===lastSharedSignature) return;
  lastSharedSignature=sig;
  if(editing) return;
  const serverHasData=(Array.isArray(state.rooms)&&state.rooms.length)||(Array.isArray(state.sliders)&&state.sliders.length);
  if(serverHasData){
    applySharedState(state);
  }else{
    normalizeRooms();normalizeSliders();
    await postSharedState();
  }
  renderRoomConfigs();renderSliderConfigs();renderLightingSliders();loadConnection();
 }catch(e){
  // Keep the current UI intact on a temporary network error.
 }
}
let syncTimer=null;
function syncSharedStateDebounced(){clearTimeout(syncTimer);syncTimer=setTimeout(postSharedState,700);}
async function postSharedState(){
 try{
  const payload={rooms:rooms(),sliders:sliders(),presets:rgbwPresets()};
  const r=await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json','Cache-Control':'no-cache'},cache:'no-store',body:JSON.stringify(payload)});
  if(!r.ok)throw new Error('save '+r.status);
  lastSharedSignature=sharedSignature(payload);
 }catch(e){}
}
syncSharedState();

function connectKnx(){const ss=sliders();const feedbackGAs=[];ss.forEach(x=>{if(x.mode==='rgbw'){(x.rgbw?.feedback||[]).forEach(g=>{if(g)feedbackGAs.push(String(g).trim())})}else if(x.feedbackGa)feedbackGAs.push(String(x.feedbackGa).trim())});send({type:'knx-connect',config:{ip:ip.value,port:Number(port.value),mode:mode.value,physAddr:phys.value,writeGa:ss[0]?.writeGa||'1/1/69',feedbackGa:feedbackGAs[0]||'2/1/69',feedbackGAs:[...new Set(feedbackGAs)]}})}
function disconnectKnx(){send({type:'knx-disconnect'})}
connectSocket();
window.addEventListener('DOMContentLoaded',()=>pageById('home'));

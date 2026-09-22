from pathlib import Path
p=Path('/mnt/data/final_work/index.html')
s=p.read_text()
old='''<div class="card s12"><div class="settings-heading"><div><h2>Lighting sliders</h2><div class="muted">Lighting is grouped by room. Add sliders directly to the room where they belong.</div></div></div>\n<div id="sliderConfigList"></div></div>\n<div class="card s12"><div class="settings-heading"><div><h2><span class="settings-section-icon">🔐</span>Security devices</h2><div class="muted">Security devices are grouped by room. Open a room to add a security device, then choose Electric lock or Motion sensor in the device.</div></div></div>\n<div id="securityConfigList"></div></div>'''
new='''<div class="card s12"><div class="settings-heading"><div><h2>Devices</h2><div class="muted">All devices are grouped by room. Open a room and use the single Add device button, then choose the device type inside the device.</div></div></div>\n<div id="deviceConfigList"></div></div>'''
if old not in s:
    raise SystemExit('settings HTML block not found')
s=s.replace(old,new)
# insert CSS
needle='.room-config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}'
css='''.device-room-group{margin:10px 0;border:1px solid var(--line);border-radius:13px;background:rgba(23,33,41,.38);overflow:hidden}.device-room-group>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:15px 16px;font-weight:800;background:rgba(255,255,255,.025)}.device-room-group>summary::-webkit-details-marker{display:none}.device-room-group>summary::before{content:'›';font-size:22px;color:var(--muted);width:16px;transition:transform .15s}.device-room-group[open]>summary::before{transform:rotate(90deg)}.device-room-count{color:var(--muted);font-size:12px;font-weight:600}.device-room-actions{margin-left:auto}.device-room-content{padding:0 10px 10px}.device-room-empty{padding:12px 6px}.unified-device{background:var(--p2);border:1px solid var(--line);border-radius:13px;padding:16px;margin:10px 0}.unified-device-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.unified-device-title{font-weight:800;font-size:16px}.unified-device-grid{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:12px;align-items:end}.unified-device-addresses{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.unified-device-note{font-size:11px;color:var(--muted);margin-top:10px}.unified-type-icon{font-size:20px;vertical-align:middle;margin-right:5px}.unified-device[data-type="security"] .unified-type-icon{color:#fff}@media(max-width:1000px){.unified-device-grid,.unified-device-addresses{grid-template-columns:1fr 1fr}}@media(max-width:650px){.unified-device-grid,.unified-device-addresses{grid-template-columns:1fr}.device-room-actions{margin-left:auto}}\n'''
s=s.replace(needle,needle+css)
# Replace renderSliderConfigs through before addSlider with unified implementation; preserve addSlider function but wrap it later.
start=s.index('function renderSliderConfigs(){')
end=s.index('function addSlider(roomName){', start)
newjs=r'''function allConfiguredDevices(){
  const out=[];
  sliders().forEach(x=>out.push({id:'light:'+x.id,type:'lighting',name:x.name||'Lighting',room:x.room||rooms()[0]||'',sourceId:x.id,source:'lighting',data:x}));
  securityDevices().forEach(x=>out.push({id:'security:'+x.id,type:'security',name:x.name||'Security device',room:x.room||rooms()[0]||'',sourceId:x.id,source:'security',data:x}));
  try{const a=JSON.parse(localStorage.getItem('knxGenericDevices')||'[]');if(Array.isArray(a))a.forEach(x=>out.push({id:'generic:'+x.id,type:x.type||'thermostat',name:x.name||'New device',room:x.room||rooms()[0]||'',sourceId:x.id,source:'generic',data:x}));}catch(e){}
  return out;
}
function saveGenericDevices(a){localStorage.setItem('knxGenericDevices',JSON.stringify(a));syncSharedStateDebounced()}
function genericDevices(){try{const a=JSON.parse(localStorage.getItem('knxGenericDevices')||'[]');return Array.isArray(a)?a:[]}catch(e){return []}}
function deviceTypeLabel(t){return ({lighting:'Lighting',security:'Security',thermostat:'Thermostat',screen:'Screen',camera:'Camera',av:'Audio & Video'})[t]||'Device'}
function deviceIcon(t){return ({lighting:'💡',security:'🔐',thermostat:'🌡️',screen:'🪟',camera:'📷',av:'🎬'})[t]||'⚙️'}
function unifiedAddressFields(item){
  const x=item.data,t=item.type;
  if(t==='lighting'){
    if((x.mode||'dim')==='rgbw'){
      const rgb=x.rgbw||{write:['','','',''],feedback:['','','','']};
      return '<div class="unified-device-addresses" style="grid-template-columns:1fr 1fr 1fr 1fr"><div><label>Red write</label><input class="knx" data-addr="rgbw-w-0" value="'+esc(rgb.write[0]||'')+'"></div><div><label>Green write</label><input class="knx" data-addr="rgbw-w-1" value="'+esc(rgb.write[1]||'')+'"></div><div><label>Blue write</label><input class="knx" data-addr="rgbw-w-2" value="'+esc(rgb.write[2]||'')+'"></div><div><label>White write</label><input class="knx" data-addr="rgbw-w-3" value="'+esc(rgb.write[3]||'')+'"></div></div><div class="unified-device-addresses" style="grid-template-columns:1fr 1fr 1fr 1fr"><div><label>Red feedback</label><input class="knx" data-addr="rgbw-f-0" value="'+esc(rgb.feedback[0]||'')+'"></div><div><label>Green feedback</label><input class="knx" data-addr="rgbw-f-1" value="'+esc(rgb.feedback[1]||'')+'"></div><div><label>Blue feedback</label><input class="knx" data-addr="rgbw-f-2" value="'+esc(rgb.feedback[2]||'')+'"></div><div><label>White feedback</label><input class="knx" data-addr="rgbw-f-3" value="'+esc(rgb.feedback[3]||'')+'"></div></div>';
    }
    return '<div class="unified-device-addresses"><div><label>Write group address</label><input class="knx" data-addr="writeGa" value="'+esc(x.writeGa||'')+'"></div><div><label>Feedback group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div></div>';
  }
  if(t==='security') return '<div class="unified-device-addresses"><div><label>Control group address</label><input class="knx" data-addr="writeGa" value="'+esc(x.writeGa||'')+'" placeholder="e.g. 1/2/10"></div><div><label>Status group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'" placeholder="e.g. 2/2/10"></div></div><div class="unified-device-note">Buttons send only to Control. Icon and status indicator react only to Status. KNX DPT 1.001 (1-bit).</div>';
  if(t==='thermostat') return '<div class="unified-device-addresses"><div><label>Control group address</label><input class="knx" data-addr="writeGa" value="'+esc(x.writeGa||'')+'"></div><div><label>Status group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div></div>';
  if(t==='screen') return '<div class="unified-device-addresses"><div><label>Control group address</label><input class="knx" data-addr="writeGa" value="'+esc(x.writeGa||'')+'"></div><div><label>Status group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div></div>';
  if(t==='camera') return '<div class="unified-device-addresses"><div><label>Camera URL</label><input data-addr="url" value="'+esc(x.url||'')+'" placeholder="rtsp:// or http://"></div><div><label>Status group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div></div>';
  return '<div class="unified-device-addresses"><div><label>Control group address</label><input class="knx" data-addr="writeGa" value="'+esc(x.writeGa||'')+'"></div><div><label>Status group address</label><input class="knx" data-addr="feedbackGa" value="'+esc(x.feedbackGa||'')+'"></div></div>';
}
function renderDeviceConfigs(){
 const box=document.getElementById('deviceConfigList');if(!box)return;
 const rs=rooms();box.innerHTML='';
 rs.forEach(room=>{
   const items=allConfiguredDevices().filter(x=>x.room===room);
   const group=document.createElement('details');group.className='device-room-group';group.open=false;
   const summary=document.createElement('summary');summary.innerHTML='<span class="slider-room-title">'+esc(room)+'</span><span class="device-room-count">'+items.length+' device'+(items.length===1?'':'s')+'</span><span class="device-room-actions"><button type="button" class="btn primary device-room-add">＋ Add device</button></span>';
   const addBtn=summary.querySelector('.device-room-add');addBtn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();addUnifiedDevice(room);});group.appendChild(summary);
   const content=document.createElement('div');content.className='device-room-content';
   if(!items.length) content.innerHTML='<div class="muted device-room-empty">No devices in this room yet.</div>';
   items.forEach(item=>{
     const x=item.data,d=document.createElement('div');d.className='unified-device';d.dataset.type=item.type;
     const typeOptions=['lighting','security','thermostat','screen','camera','av'].map(t=>'<option value="'+t+'" '+(item.type===t?'selected':'')+'>'+deviceTypeLabel(t)+'</option>').join('');
     const sub=(item.type==='lighting'?(x.mode==='rgbw'?'RGBW':'Dim'):'');
     d.innerHTML='<div class="unified-device-head"><div class="unified-device-title"><span class="unified-type-icon">'+deviceIcon(item.type)+'</span>'+esc(x.name||item.name)+'</div><button type="button" class="btn danger">Remove</button></div><div class="unified-device-grid"><div><label>Name</label><input data-u="name" value="'+esc(x.name||item.name)+'"></div><div><label>Room</label><select data-u="room">'+roomOptions(item.room)+'</select></div><div><label>Type</label><select data-u="type">'+typeOptions+'</select></div>'+ (item.type==='lighting'?'<div><label>Lighting mode</label><select data-u="mode"><option value="dim" '+(x.mode!=='rgbw'?'selected':'')+'>Dim</option><option value="rgbw" '+(x.mode==='rgbw'?'selected':'')+'>RGBW</option></select></div>':'<div></div>')+'</div>'+unifiedAddressFields(item);
     d.querySelector('.btn.danger').addEventListener('click',()=>removeUnifiedDevice(item));
     d.querySelectorAll('[data-u]').forEach(el=>el.addEventListener('change',()=>updateUnifiedDevice(item,el)));
     d.querySelectorAll('[data-addr]').forEach(el=>el.addEventListener('change',()=>updateUnifiedAddress(item,el)));
     content.appendChild(d);
   });
   group.appendChild(content);box.appendChild(group);
 });
}
function updateUnifiedDevice(item,el){
 if(item.source==='lighting'){
   const a=sliders(),x=a.find(z=>z.id===item.sourceId);if(!x)return;
   if(el.dataset.u==='type' && el.value!=='lighting'){convertLightingToGeneric(x,el.value);return}
   if(el.dataset.u==='name')x.name=el.value.trim()||'Lighting';
   if(el.dataset.u==='room')x.room=el.value;
   if(el.dataset.u==='mode'){x.mode=el.value;x.rgbw=x.rgbw||{write:['','','',''],feedback:['','','','']};}
   saveSliders(a);
 } else if(item.source==='security'){
   const a=securityDevices(),x=a.find(z=>z.id===item.sourceId);if(!x)return;
   if(el.dataset.u==='type' && el.value!=='security'){convertSecurityToGeneric(x,el.value);return}
   if(el.dataset.u==='name')x.name=el.value.trim()||'Security device';
   if(el.dataset.u==='room')x.room=el.value;
   saveSecurityDevices(a);
 } else {
   const a=genericDevices(),x=a.find(z=>z.id===item.sourceId);if(!x)return;
   if(el.dataset.u==='type' && el.value!==x.type){x.type=el.value;saveGenericDevices(a);renderDeviceConfigs();return}
   x[el.dataset.u]=el.value;
   saveGenericDevices(a);
 }
 renderDeviceConfigs();renderLightingSliders();renderSecurity();
}
function updateUnifiedAddress(item,el){
 const key=el.dataset.addr;
 if(item.source==='lighting'){
   const a=sliders(),x=a.find(z=>z.id===item.sourceId);if(!x)return;x.rgbw=x.rgbw||{write:['','','',''],feedback:['','','','']};
   if(key.startsWith('rgbw-')){const [kind,idx]=key.split('-').slice(1); if(el.value && !gaOK(el.value)){toast('Use for example 1/1/69');return}x.rgbw[kind][Number(idx)]=el.value.trim();}
   else x[key]=el.value.trim(); saveSliders(a);
 } else if(item.source==='security'){
   const a=securityDevices(),x=a.find(z=>z.id===item.sourceId);if(!x)return;x[key]=el.value.trim();saveSecurityDevices(a);
 } else {const a=genericDevices(),x=a.find(z=>z.id===item.sourceId);if(!x)return;x[key]=el.value.trim();saveGenericDevices(a)}
}
function convertLightingToGeneric(x,type){
 const a=sliders().filter(z=>z.id!==x.id);saveSliders(a);const g=genericDevices();g.push({id:'g'+Date.now(),type,name:x.name,room:x.room,writeGa:x.writeGa||'',feedbackGa:x.feedbackGa||'',url:''});saveGenericDevices(g);renderDeviceConfigs();renderLightingSliders();toast('Device type changed');
}
function convertSecurityToGeneric(x,type){
 const a=securityDevices().filter(z=>z.id!==x.id);saveSecurityDevices(a);const g=genericDevices();g.push({id:'g'+Date.now(),type,name:x.name,room:x.room,writeGa:x.writeGa||'',feedbackGa:x.feedbackGa||'',url:''});saveGenericDevices(g);renderDeviceConfigs();renderSecurity();toast('Device type changed');
}
function addUnifiedDevice(roomName){
 const room=roomName||rooms()[0]||'Overig';const g=genericDevices();g.push({id:'g'+Date.now(),type:'lighting',name:'New device',room,mode:'dim',writeGa:'',feedbackGa:'',rgbw:{write:['','','',''],feedback:['','','','']}});saveGenericDevices(g);renderDeviceConfigs();toast('New device added to '+room);
}
function removeUnifiedDevice(item){
 if(item.source==='lighting')removeSlider(item.sourceId);
 else if(item.source==='security')removeSecurityDevice(item.sourceId);
 else {saveGenericDevices(genericDevices().filter(x=>x.id!==item.sourceId));renderDeviceConfigs();toast('Device removed')}
}
function renderSliderConfigs(){renderDeviceConfigs()}
function renderSecurityConfigs(){renderDeviceConfigs()}
'''
s=s[:start]+newjs+s[end:]
# Replace settings calls / old render refs by unified (but wrappers cover most)
s=s.replace('renderSliderConfigs();renderLightingSliders();toast(\'Ruimte toegevoegd\')','renderDeviceConfigs();renderLightingSliders();renderSecurity();toast(\'Ruimte toegevoegd\')')
s=s.replace('renderRoomConfigs();renderSliderConfigs();renderLightingSliders();toast(\'Room removed\')','renderRoomConfigs();renderDeviceConfigs();renderLightingSliders();renderSecurity();toast(\'Room removed\')')
# Existing addSlider function can remain but now not used; make it create via unified
# Replace first occurrence of addSlider(roomName) block (the one before removeSlider)
import re
pat=r"function addSlider\(roomName\)\{.*?\n\}\nfunction removeSlider\(id\)"
m=re.search(pat,s,re.S)
if m:
    repl="function addSlider(roomName){ addUnifiedDevice(roomName); }\nfunction removeSlider(id)"
    s=s[:m.start()]+repl+s[m.end():]
# There is duplicate addSlider() later; rename it to legacy no-op? Replace exact second block
pat2=r"function addSlider\(\)\{.*?\n\}\nfunction removeSlider\(id\)"
ms=list(re.finditer(pat2,s,re.S))
if ms:
    m=ms[-1]
    repl="function addSlider(){ addUnifiedDevice(rooms()[0]||'Overig'); }\nfunction removeSlider(id)"
    s=s[:m.start()]+repl+s[m.end():]
# Make settings page render unified directly after room configs
s=s.replace('renderRoomConfigs();renderSliderConfigs();renderSecurityConfigs();','renderRoomConfigs();renderDeviceConfigs();')
s=s.replace('renderRoomConfigs();renderSliderConfigs();','renderRoomConfigs();renderDeviceConfigs();')
# Generic devices should show in initial normalization? no.
p.write_text(s)
print('patched',p)

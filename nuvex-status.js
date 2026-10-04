(() => {
  const top=document.querySelector('main > .top'),host=document.getElementById('pageHost');
  if(!top || !host)return;
  const style=document.createElement('style');
  style.textContent=`
    .nuvex-status{display:flex;gap:32px;align-items:center;margin-left:auto;flex-shrink:0;padding:4px 0}
    .nuvex-status[hidden]{display:none!important}
    .nuvex-status-item{min-width:100px;text-align:right}
    .nuvex-status-item + .nuvex-status-item{border-left:1px solid #c3d7e32b;padding-left:32px}
    .nuvex-status-value{display:block;font-size:36px;font-weight:300;letter-spacing:-.045em;line-height:1.05;font-variant-numeric:tabular-nums;color:#f0f5f8;white-space:nowrap;text-shadow:0 2px 18px #0008}
    .nuvex-status-label{display:block;font-size:10px;letter-spacing:.13em;color:#b4c3cc;margin-top:9px;text-transform:uppercase}
    @media(max-width:850px){main > .top{flex-wrap:wrap}.nuvex-status{width:100%;margin:8px 0 0;gap:24px;padding:8px 0 2px}.nuvex-status-item{flex:1;min-width:0;text-align:left}.nuvex-status-item + .nuvex-status-item{padding-left:24px}.nuvex-status-value{font-size:34px}.nuvex-status-label{font-size:9px;letter-spacing:.1em}}
  `;
  document.head.append(style);
  const status=document.createElement('div');status.className='nuvex-status';
  status.innerHTML='<div class="nuvex-status-item"><time class="nuvex-status-value" id="nuvexClock"></time><span class="nuvex-status-label" id="nuvexDate"></span></div><div class="nuvex-status-item"><span class="nuvex-status-value" id="nuvexOutdoor" aria-label="Buitentemperatuur">— °C</span><span class="nuvex-status-label" id="nuvexWeatherLabel">Buiten</span></div>';
  top.append(status);
  const clock=status.querySelector('#nuvexClock'),date=status.querySelector('#nuvexDate'),temperature=status.querySelector('#nuvexOutdoor'),label=status.querySelector('#nuvexWeatherLabel');
  const timeFormat=new Intl.DateTimeFormat('nl-NL',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Amsterdam'});
  const dateFormat=new Intl.DateTimeFormat('nl-NL',{weekday:'short',day:'numeric',month:'short',timeZone:'Europe/Amsterdam'});
  function updateClock(){const now=new Date();clock.textContent=timeFormat.format(now);clock.dateTime=now.toISOString();date.textContent=dateFormat.format(now);}
  function visibility(){const page=host.querySelector('section.page');const overview=page?.id==='home';status.hidden=!overview && (innerWidth<=850 || top.clientWidth<780);if(page?.id==='settings')settingsPanel(page);}
  new MutationObserver(visibility).observe(host,{childList:true});new ResizeObserver(visibility).observe(top);
  async function weather(){
    try {
      const response=await fetch('/api/outdoor-weather',{cache:'no-store'});if(!response.ok)throw Error();
      const data=await response.json();
      if(!data.configured){label.textContent='Locatie nog instellen';temperature.textContent='— °C';return;}
      if(data.source==='knx' && data.status!=='ok'){temperature.textContent='— °C';label.textContent=data.status==='offline'?'KNX weerstation offline':'Wachten op KNX weerstation';return;}
      if(typeof data.temperature!=='number' || !Number.isFinite(Date.parse(data.updatedAt)) || Date.now()-Date.parse(data.updatedAt)>3600000)throw Error();
      temperature.textContent=new Intl.NumberFormat('nl-NL',{maximumFractionDigits:1,minimumFractionDigits:1}).format(data.temperature)+' °C';
      label.textContent='Buiten';
      temperature.title=(data.station||'')+' · bijgewerkt om '+timeFormat.format(new Date(data.updatedAt));
    }catch{temperature.textContent='— °C';temperature.title='';label.textContent='Weer niet beschikbaar';}
  }
  function settingsPanel(page){
    if(page.querySelector('#nuvexWeatherSettings'))return;
    const panel=document.createElement('details');panel.id='nuvexWeatherSettings';panel.className='card s12 settings-section';
    panel.innerHTML='<summary class="settings-heading settings-collapse-summary"><div><h2>Locatie &amp; buitenweer</h2><div class="muted">KNX weerstation heeft voorrang op Buienradar.</div></div></summary><div class="settings-section-body"><p data-weather-info>Locatie ophalen…</p><p class="muted">Automatische locatie is gebaseerd op de internetverbinding van de Nuvex-computer.</p><label>Plaatsnaam</label><input data-weather-city placeholder="Bijvoorbeeld Rotterdam" autocomplete="address-level2"><div class="actions" style="margin-top:12px"><button type="button" class="btn" data-weather-search>Zoek plaats</button><button type="button" class="btn" data-weather-auto>Automatisch bepalen</button></div><div data-weather-results></div><p class="muted" data-weather-message role="status"></p></div>';
    const attribution=document.createElement('p');attribution.className='muted';
    attribution.append(document.createTextNode('Weergegevens: '));
    const source=document.createElement('a');source.href='https://www.buienradar.nl/';source.target='_blank';source.rel='noopener';source.textContent='Buienradar.nl';source.style.color='inherit';attribution.append(source);
    panel.querySelector('.settings-section-body').append(attribution);
    (page.querySelector('.grid')||page).append(panel);
    const info=panel.querySelector('[data-weather-info]'),message=panel.querySelector('[data-weather-message]'),city=panel.querySelector('[data-weather-city]'),results=panel.querySelector('[data-weather-results]');
    async function load(){try{const r=await fetch('/api/weather-settings',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error);info.textContent=(d.name||'Nog niet gevonden')+' · '+(d.mode==='manual'?'Handmatig':'Automatisch')+' · bron: '+(d.source==='knx'?d.station+' (KNX)':'Buienradar');message.textContent=d.error||'';}catch(e){message.textContent=e.message;}}
    async function save(input){const r=await fetch('/api/weather-settings',{method:'POST',headers:typeof settingsRequestHeaders==='function'?settingsRequestHeaders({'Content-Type':'application/json'}):{'Content-Type':'application/json'},body:JSON.stringify(input)});const d=await r.json();if(!r.ok)throw Error(d.error||'Opslaan mislukt');return d;}
    async function busy(work){panel.querySelectorAll('button').forEach(b=>b.disabled=true);message.textContent='Even wachten…';try{await work();}catch(e){message.textContent=e.message;}finally{panel.querySelectorAll('button').forEach(b=>b.disabled=false);}}
    panel.querySelector('[data-weather-auto]').onclick=()=>busy(async()=>{await save({mode:'auto'});results.replaceChildren();await load();await weather();});
    panel.querySelector('[data-weather-search]').onclick=()=>busy(async()=>{
      const name=city.value.trim(),d=await save({mode:'manual',name});results.replaceChildren();message.textContent=d.candidates?.length?'Kies de juiste plaats:':'Geen plaats gevonden.';
      for(const candidate of d.candidates||[]){const button=document.createElement('button');button.type='button';button.className='btn';button.style.margin='8px 8px 0 0';button.textContent=candidate.name;button.onclick=()=>busy(async()=>{await save({mode:'manual',name,locationId:candidate.id});results.replaceChildren();await load();await weather();});results.append(button);}
    });load();
  }
  updateClock();visibility();weather();setInterval(updateClock,1000);setInterval(()=>{if(!document.hidden)weather();},30000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateClock();weather();}});
})();

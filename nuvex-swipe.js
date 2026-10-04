(() => {
  function direction(start,end,width){const dx=end.x-start.x,dy=end.y-start.y,elapsed=end.time-start.time;if(elapsed<40||elapsed>850||Math.abs(dx)<Math.min(120,Math.max(70,width*.2))||Math.abs(dx)<Math.abs(dy)*1.8)return 0;return dx<0?1:-1;}
  if(typeof module!=='undefined')module.exports={direction};
  if(typeof document==='undefined')return;
  const host=document.getElementById('pageHost');if(!host)return;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const desktopNavigation=matchMedia('(min-width:851px)');
  let gesture=null,lockedUntil=0,animation=null;
  function pages(includeSettings=false){return [...document.querySelectorAll('aside nav button')].filter(b=>!b.hidden&&b.style.display!=='none').map(b=>{const id=(b.getAttribute('onclick')||'').match(/page\('([^']+)'/);return id&&(includeSettings||id[1]!=='settings')?{id:id[1],button:b,label:b.textContent.trim().replace(/^[^\p{L}\p{N}]+/u,'')}:null;}).filter(Boolean);}
  function current(){return host.querySelector('section.page')?.id;}
  const hint=document.createElement('nav');
  hint.className='nuvex-swipe-hint';hint.setAttribute('aria-label','Pagina’s');hint.hidden=true;
  document.body.append(hint);
  function reserveNavigationSpace(){
    const reserve=hint.hidden?0:Math.ceil(hint.getBoundingClientRect().height+(parseFloat(getComputedStyle(hint).bottom)||0)+4);
    document.body.style.setProperty('--nuvex-navigation-space',reserve+'px');
  }
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(reserveNavigationSpace).observe(hint);
  window.addEventListener('resize',reserveNavigationSpace);
  let barKey='',barActive='';
  const barLabels={shading:'Curtains',av:'A/V'};
  const icons={
    home:'m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
    lighting:'M9 17h6m-5 4h4M8 13a6 6 0 1 1 8 0l-1 4H9Z',
    shading:'M3 4h18M5 4v16l7-4 7 4V4M12 4v12',
    av:'M4 5h16v12H4ZM8 21h8m-4-4v4m-2-13 5 3-5 3Z',
    cameras:'M4 7h4l2-3h4l2 3h4v13H4ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    climate:'M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0m2-7v10',
    security:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM8 12l3 3 5-6',
    energy:'m13 2-8 12h6l-1 8 9-12h-6Z',
    automation:'M4 8a8 8 0 0 1 14-2l2 2M20 3v5h-5M20 16a8 8 0 0 1-14 2l-2-2M4 21v-5h5',
    scenes:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
    settings:'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2'
  };
  function revealActivePage(){
    requestAnimationFrame(()=>{
      if(hint.hidden)return;
      const active=hint.querySelector('[aria-current="page"]');if(!active)return;
      const left=active.offsetLeft,right=left+active.offsetWidth;
      if(left<hint.scrollLeft||right>hint.scrollLeft+hint.clientWidth)
        hint.scrollTo({left:Math.max(0,left-(hint.clientWidth-active.offsetWidth)/2),behavior:'auto'});
    });
  }
  function updateHint(){
    const list=pages(true),active=current(),index=list.findIndex(p=>p.id===active);
    const visible=desktopNavigation.matches&&document.body.classList.contains('sidebar-collapsed')&&index>=0&&list.length>1;
    const wasHidden=hint.hidden;
    hint.hidden=!visible;if(document.body.classList.contains('nuvex-has-swipe-hint')!==visible)document.body.classList.toggle('nuvex-has-swipe-hint',visible);
    reserveNavigationSpace();
    const key=list.map(p=>p.id+':'+p.label).join('|'),changed=key!==barKey;
    if(changed){barKey=key;const scrollLeft=hint.scrollLeft;
    hint.replaceChildren();
    for(const [i,target] of list.entries()){
      const item=document.createElement('button');item.type='button';item.className='swipe-page';
      item.setAttribute('aria-label',target.label);item.title=target.label;
      item.dataset.page=target.id;
      item.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(icons[target.id]||icons.home)+'"/></svg>';
      const label=document.createElement('span');label.textContent=barLabels[target.id]||target.label;item.append(label);
      item.addEventListener('click',()=>navigate(target,0));hint.append(item);
    }
    hint.scrollLeft=scrollLeft;}
    hint.querySelectorAll('.swipe-page').forEach(item=>{
      const selected=item.dataset.page===active;item.classList.toggle('active',selected);
      if(selected)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
    });
    if(visible&&(changed||barActive!==active||wasHidden))revealActivePage();
    barActive=active;
  }
  async function navigate(target,step=0){
    if((step&&Date.now()<lockedUntil)||target.id===current()||!pages(true).some(p=>p.id===target.id))return;
    if(!step){animation?.cancel();lockedUntil=0;}else lockedUntil=Date.now()+550;
    const previous=current();gesture=null;
    if(step&&!reduced.matches&&host.animate){
      const matrix=getComputedStyle(host).transform;animation?.cancel();host.style.transform='';
      animation=host.animate([{transform:matrix==='none'?'translateX(0)':matrix,opacity:1},{transform:'translateX('+(-step*innerWidth*.6)+'px)',opacity:.15}],{duration:170,easing:'ease-in',fill:'forwards'});
      try{await animation.finished;}catch{return;}
      if(current()!==previous){animation.cancel();return;}animation.cancel();
    }
    host.style.transform='';target.button.click();
    if(step&&current()===target.id&&!reduced.matches&&host.animate)animation=host.animate([{transform:'translateX('+(step*innerWidth*.45)+'px)',opacity:.25},{transform:'translateX(0)',opacity:1}],{duration:300,easing:'cubic-bezier(.22,1,.36,1)'});
  }
  function reset(){gesture=null;const transform=host.style.transform;host.style.transform='';if(transform&&!reduced.matches&&host.animate){animation?.cancel();animation=host.animate([{transform},{transform:'translateX(0)'}],{duration:220,easing:'ease-out'});}}
  function blocked(target){if(target.closest('input,button,select,textarea,a,summary,[role="button"],[role="slider"],.switch,[contenteditable="true"],.tv-remote-pages,.nax-menu,.camera-tile'))return true;for(let n=target;n&&n!==host;n=n.parentElement){const s=getComputedStyle(n);if(/auto|scroll/.test(s.overflowX)&&n.scrollWidth>n.clientWidth+2)return true;}return false;}
  host.addEventListener('touchstart',e=>{
    reset();if(e.touches.length!==1||(!document.body.classList.contains('sidebar-collapsed')&&innerWidth<=850)||current()==='settings'||blocked(e.target)||Date.now()<lockedUntil)return;
    const t=e.touches[0];if(t.clientX<24||t.clientX>innerWidth-24)return;animation?.cancel();gesture={x:t.clientX,y:t.clientY,time:performance.now(),id:t.identifier,page:current(),horizontal:false};
  },{passive:true});
  host.addEventListener('touchmove',e=>{
    if(!gesture)return;if(e.touches.length!==1){reset();return;}const t=e.touches[0],dx=t.clientX-gesture.x,dy=t.clientY-gesture.y;
    if(!gesture.horizontal&&Math.abs(dy)>16&&Math.abs(dy)>Math.abs(dx)){reset();return;}
    if(Math.abs(dx)>16&&Math.abs(dx)>Math.abs(dy)*1.8)gesture.horizontal=true;
    if(gesture.horizontal){if(e.cancelable)e.preventDefault();const list=pages(),index=list.findIndex(p=>p.id===current()),available=list[index+(dx<0?1:-1)];if(!reduced.matches)host.style.transform='translateX('+(available?dx:dx*.15)+'px)';}
  },{passive:false});
  host.addEventListener('touchend',e=>{
    const start=gesture;if(!start){reset();return;}gesture=null;if(start.page!==current()){reset();return;}
    const t=[...e.changedTouches].find(t=>t.identifier===start.id),step=t?direction(start,{x:t.clientX,y:t.clientY,time:performance.now()},innerWidth):0,list=pages(),index=list.findIndex(p=>p.id===current()),target=list[index+step];
    if(step&&target&&index>=0)navigate(target,step);else reset();
  },{passive:true});
  host.addEventListener('touchcancel',reset,{passive:true});
  new MutationObserver(()=>{if(gesture&&gesture.page!==current())reset();updateHint();}).observe(host,{childList:true});
  new MutationObserver(updateHint).observe(document.body,{attributes:true,attributeFilter:['class']});
  const navigation=document.querySelector('aside');
  if(navigation)new MutationObserver(updateHint).observe(navigation,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','style']});
  desktopNavigation.addEventListener('change',updateHint);
  updateHint();
})();

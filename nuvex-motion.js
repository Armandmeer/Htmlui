(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const style = document.createElement('style');
  style.textContent = `
    body.nuvex-motion .app{display:block!important;padding-left:260px;transition:padding-left .72s cubic-bezier(.22,1,.36,1)}
    body.nuvex-motion.sidebar-collapsed .app{padding-left:0}
    body.nuvex-motion aside{position:fixed!important;inset:0 auto 0 0;width:260px!important;min-height:0!important;overflow-y:auto;overflow-x:hidden;padding-top:76px!important;z-index:1000;transform-origin:left center;transform:perspective(1000px) translateX(0) rotateY(0) scale(1)!important;opacity:1!important;transition:transform .72s cubic-bezier(.22,1,.36,1),opacity .5s ease,box-shadow .65s ease!important;box-shadow:12px 0 50px #0008,inset -1px 0 #41bfff55!important}
    body.nuvex-motion.sidebar-collapsed aside{transform:perspective(1000px) translateX(-110%) rotateY(32deg) scale(.92)!important;opacity:0!important;pointer-events:none!important;box-shadow:0 0 65px #00bfff66!important}
    body.nuvex-motion .menu-toggle{display:flex!important;align-items:center;justify-content:center;border-color:#57bfff66;background:#061425df}
    body.nuvex-motion .menu-toggle{transition:background .3s,box-shadow .3s,border-color .3s;overflow:hidden}
    body.nuvex-motion .menu-toggle[aria-expanded="true"]{border-color:#64dbff;background:#0b2a3be8;box-shadow:0 0 22px #00c8ff55,inset 0 0 12px #00bfff22}
    .nuvex-menu-energy{position:fixed;left:0;top:0;bottom:0;width:280px;z-index:10005;pointer-events:none;overflow:hidden;opacity:0}
    .nuvex-menu-energy .energy-edge{position:absolute;top:0;bottom:0;width:3px;left:258px;background:linear-gradient(180deg,transparent,#08beff 20%,#d9ffff 45%,#ffab42 75%,transparent);box-shadow:0 0 12px #00c8ff,0 0 35px #00bfff,0 0 55px #ff9d32}
    .nuvex-menu-energy .energy-scan{position:absolute;inset:-30% 0;background:linear-gradient(180deg,transparent 43%,#00c8ff08 47%,#88eeff99 50%,#ff982533 51%,transparent 56%);transform:translateY(-80%)}
    .nuvex-menu-energy .energy-sparks{position:absolute;inset:0;background:repeating-linear-gradient(110deg,transparent 0 39px,#34cfff33 40px,transparent 42px 78px);mask-image:linear-gradient(90deg,transparent,#000);opacity:.5}
    .nuvex-menu-energy .energy-particle{position:absolute;left:18px;top:var(--spark-top);width:var(--spark-size);height:2px;background:var(--spark-color);box-shadow:0 0 8px var(--spark-color);border-radius:99px}
    body.nuvex-motion main{padding-top:80px}
    body.nuvex-motion .sidebar-backdrop{display:none!important}
    body.nuvex-motion .nuvex-ai-sidebar-brand img{animation:nuvex-logo-breathe 4s ease-in-out infinite!important;transition:filter .25s!important;transform:perspective(500px) rotateX(var(--logo-y,0deg)) rotateY(var(--logo-x,0deg))!important}
    body.nuvex-motion .nuvex-ai-sidebar-brand:hover img,body.nuvex-motion .nuvex-ai-sidebar-brand:focus-visible img{filter:drop-shadow(0 0 15px #00bfff) drop-shadow(0 0 6px #ff922c)!important}
    body.nuvex-motion .nuvex-ai-sidebar-brand:focus-visible{outline:2px solid #55caff!important;outline-offset:4px!important;border-radius:12px}
    #nuvexUiBackground{transform:translate(var(--scene-x,0px),var(--scene-y,0px)) scale(1.035);transition:transform .8s ease-out;animation:nuvex-scene-breathe 18s ease-in-out infinite}
    body.nuvex-motion #nuvexUiBackground:after{animation:none!important}
    @keyframes nuvex-logo-breathe{0%,100%{filter:drop-shadow(0 0 3px #00aaff55)}50%{filter:drop-shadow(0 0 10px #00aaff99) drop-shadow(0 0 4px #ff922c77)}}
    @keyframes nuvex-scene-breathe{0%,100%{background-position:50% 50%}50%{background-position:51% 49%}}
    @keyframes nuvex-light{0%,100%{opacity:.5}50%{opacity:1}}
    .nuvex-electric-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:screen}
    body.nuvex-motion .nuvex-ai-sidebar-brand{position:relative!important}
    body.nuvex-motion .nuvex-ai-sidebar-brand img{position:relative!important;z-index:1!important;flex:0 0 auto!important;visibility:visible!important;opacity:1!important;width:215px!important;max-width:100%!important;height:104px!important;object-fit:contain!important;mix-blend-mode:normal!important}
    body.nuvex-motion .nuvex-ai-sidebar-brand .nuvex-electric-canvas{z-index:2;mix-blend-mode:normal;opacity:.65}
    .nuvex-device-charge{position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:5;overflow:hidden;border:1px solid #59deff;box-shadow:inset 0 0 22px #00bfff44,0 0 20px #00bfff55}
    .nuvex-device-charge:before{content:'';position:absolute;inset:-50%;background:linear-gradient(110deg,transparent 42%,#00c8ff15 46%,#b8faffaa 49%,#ffad5555 51%,transparent 55%);transform:translateX(-50%);animation:nuvex-device-scan .9s ease-out var(--charge-delay,0ms) both}
    @keyframes nuvex-device-scan{to{transform:translateX(50%)}}
    @media(prefers-reduced-motion:reduce){.nuvex-device-charge{display:none}}
    body.nuvex-motion .nuvex-ai-sidebar-brand img{transform:none!important;animation:none!important}
    #nuvexUiBackground{transform:none!important;animation:none!important}
    @media(max-width:850px){body.nuvex-motion .app{padding-left:0}}
    @media(prefers-reduced-motion:reduce){body.nuvex-motion .nuvex-ai-sidebar-brand img,#nuvexUiBackground,body.nuvex-motion #nuvexUiBackground:after{animation:none!important;transform:none!important}body.nuvex-motion .app,body.nuvex-motion aside{transition:none!important}.nuvex-menu-energy{display:none}}
    body.nuvex-motion.motion-paused .nuvex-ai-sidebar-brand img,body.motion-paused #nuvexUiBackground,body.motion-paused #nuvexUiBackground:after{animation-play-state:paused!important}
  `;
  document.head.append(style);
  const aside = document.querySelector('aside');
  if (aside) {
    document.body.classList.add('nuvex-motion');
    const toggle = document.querySelector('.menu-toggle');
    aside.id = 'nuvexSidebar';
    toggle.setAttribute('aria-controls', aside.id);
    const energy=document.createElement('div');
    energy.className='nuvex-menu-energy';energy.setAttribute('aria-hidden','true');
    energy.innerHTML='<div class="energy-sparks"></div><div class="energy-scan"></div><div class="energy-edge"></div>';
    for(let i=0;i<20;i++){
      const spark=document.createElement('i');spark.className='energy-particle';
      spark.style.setProperty('--spark-top',(8+i*4.5)+'%');spark.style.setProperty('--spark-size',(8+i%4*5)+'px');
      spark.style.setProperty('--spark-color',i%3?'#65dbff':'#ffba60');energy.append(spark);
    }
    document.body.append(energy);
    let menuAnimations=[];
    function animateMenu(open) {
      menuAnimations.forEach(animation=>animation.cancel());menuAnimations=[];
      if(reduced.matches || !aside.animate)return;
      const run=(element,frames,options)=>{const animation=element.animate(frames,options);menuAnimations.push(animation);};
      run(energy,[{opacity:0},{opacity:.95,offset:.25},{opacity:.65,offset:.65},{opacity:0}],{duration:open?850:650,easing:'ease-out'});
      run(energy.querySelector('.energy-edge'),[{transform:open?'translateX(-260px)':'translateX(0)'},{transform:open?'translateX(0)':'translateX(-260px)'}],{duration:open?720:600,easing:'cubic-bezier(.22,1,.36,1)'});
      run(energy.querySelector('.energy-scan'),[{transform:open?'translateY(-65%)':'translateY(65%)'},{transform:open?'translateY(65%)':'translateY(-65%)'}],{duration:800,easing:'ease-in-out'});
      energy.querySelectorAll('.energy-particle').forEach((spark,i)=>run(spark,[
        {transform:open?'translateX(-30px) scaleX(.2)':'translateX(240px) scaleX(1)',opacity:0},
        {opacity:1,offset:.25},
        {transform:open?'translateX(270px) scaleX(1.5)':'translateX(-40px) scaleX(.2)',opacity:0}
      ],{duration:450+i%4*70,delay:i%6*35,easing:'ease-out'}));
      run(toggle,[{transform:'scale(1) rotate(0deg)'},{transform:'scale(.86) rotate(-12deg)',offset:.3},{transform:'scale(1.12) rotate(8deg)',offset:.65},{transform:'scale(1) rotate(0deg)'}],{duration:500,easing:'ease-out'});
      const items=[...aside.querySelectorAll('.label,nav button,.sidebar-status')].filter(item=>!item.hidden);
      items.forEach((item,index)=>run(item,open?[
        {opacity:0,transform:'translateX(-35px) scale(.92)',filter:'blur(5px)'},
        {opacity:1,transform:'translateX(4px) scale(1.015)',filter:'blur(0)',offset:.75},
        {opacity:1,transform:'translateX(0) scale(1)',filter:'blur(0)'}
      ]:[{opacity:1,transform:'translateX(0)'},{opacity:0,transform:'translateX(-30px)'}],{
        duration:open?440:220,delay:open?100+index*35:Math.max(0,items.length-1-index)*12,easing:'cubic-bezier(.22,1,.36,1)',fill:'backwards'
      }));
    }
    function setOpen(open,animate=true) {
      document.body.classList.toggle('sidebar-collapsed', !open);
      aside.classList.toggle('open', open);
      aside.inert = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Menu sluiten' : 'Menu openen');
      toggle.textContent=open?'✕':'☰';
      if(animate)animateMenu(open);
    }
    window.toggleSidebar = () => setOpen(document.body.classList.contains('sidebar-collapsed'));
    // Navigation closes the drawer on phones; desktop keeps manual menu control.
    window.closeSidebar = () => {if(matchMedia('(max-width:850px)').matches)setOpen(false);};
    setOpen(!matchMedia('(max-width:850px)').matches,false);
    const brand = aside.querySelector('.nuvex-ai-sidebar-brand');
    const logo=brand?.querySelector('img');
    if(logo){logo.src='/nuvex-sidebar-mobile.png?v=2';logo.loading='eager';logo.decoding='sync';}
    animateElectricity(brand);
    animatePages();
    enhanceSliders();
    brand?.addEventListener('pointermove', e => {
      if (reduced.matches) return;
      const r = brand.getBoundingClientRect();
      brand.style.setProperty('--logo-x', ((e.clientX-r.left)/r.width-.5)*18+'deg');
      brand.style.setProperty('--logo-y', -((e.clientY-r.top)/r.height-.5)*18+'deg');
    });
    brand?.addEventListener('pointerleave', () => { brand.style.setProperty('--logo-x','0deg');brand.style.setProperty('--logo-y','0deg'); });
  }
  function enhanceSliders(){
    const host=document.getElementById('pageHost');if(!host)return;
    function update(input){
      const min=Number(input.min||0),max=Number(input.max||100),value=Number(input.value);
      const fill=max>min?Math.max(0,Math.min(100,(value-min)/(max-min)*100)):0;
      input.style.setProperty('--control-fill',fill+'%');
      input.style.setProperty('--fill',fill+'%');
    }
    // Drag anywhere on the bar, rather than trying to grab an invisible native thumb.
    let drag=null;
    function moveSlider(event){
      const input=drag.input,rect=input.getBoundingClientRect();if(!rect.width)return;
      const min=Number(input.min||0),max=Number(input.max||100);
      let fraction=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));
      if(getComputedStyle(input).direction==='rtl')fraction=1-fraction;
      let value=min+fraction*(max-min);
      const step=input.step==='any'?0:Number(input.step||1);
      if(step>0)value=min+Math.round((value-min)/step)*step;
      const previous=input.value;input.value=String(Number(Math.max(min,Math.min(max,value)).toFixed(10)));
      update(input);
      if(input.value!==previous)input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    host.addEventListener('pointerdown',event=>{
      const input=event.target.closest('input[type=range]');
      if(!input||input.disabled||event.button!==0||!event.isPrimary||drag)return;
      event.preventDefault();input.focus({preventScroll:true});
      drag={input,id:event.pointerId,start:input.value};input.dataset.nuvexDragging='true';
      input.setPointerCapture(event.pointerId);moveSlider(event);
    });
    host.addEventListener('pointermove',event=>{
      if(!drag||event.pointerId!==drag.id)return;
      event.preventDefault();moveSlider(event);
    });
    function finishDrag(event){
      if(!drag||event.pointerId!==drag.id)return;
      if(event.type==='pointerup')moveSlider(event);
      const {input,id,start}=drag;drag=null;delete input.dataset.nuvexDragging;
      if(input.hasPointerCapture(id))input.releasePointerCapture(id);
      if(input.value!==start)input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    host.addEventListener('pointerup',finishDrag);
    host.addEventListener('pointercancel',finishDrag);
    host.addEventListener('lostpointercapture',finishDrag);
    host.addEventListener('input',event=>{if(event.target.matches('input[type=range]'))update(event.target);});
    const sync=()=>host.querySelectorAll('input[type=range]').forEach(update);
    new MutationObserver(sync).observe(host,{childList:true,subtree:true});sync();
  }
  function animatePages() {
    const host=document.getElementById('pageHost');if(!host)return;
    let current=null,animations=[],deviceSeen=new WeakSet(),deviceUntil=0,deviceFrame=0,deviceIndex=0;
    const deviceSelector='.lighting-control,.rgbw-control,.security-item,.thermostat-card,.climate-device-card,.camera-tile,.av-device-card,.shading-control,.device,.overview-room';
    function revealDevices(){
      deviceFrame=0;
      if(reduced.matches || !current || performance.now()>deviceUntil)return;
      const devices=[...current.querySelectorAll(deviceSelector)].filter(el=>!el.hidden && getComputedStyle(el).display!=='none');
      devices.filter(el=>!devices.some(other=>other!==el && el.contains(other))).forEach(el=>{
        if(deviceSeen.has(el))return;deviceSeen.add(el);
        const delay=Math.min(deviceIndex++*65,650);
        animations.push(el.animate([
          {opacity:0,transform:'perspective(800px) translate3d(50px,24px,-80px) rotateY(-12deg) scale(.88)',filter:'blur(5px)'},
          {opacity:1,transform:'perspective(800px) translate3d(-4px,-2px,0) rotateY(2deg) scale(1.025)',filter:'blur(0)',offset:.72},
          {opacity:1,transform:'perspective(800px) translate3d(0,0,0) rotateY(0) scale(1)',filter:'blur(0)'}
        ],{duration:850,delay,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}));
        // Keep effects out of the control layout and remove them after the entrance.
        const oldPosition=el.style.position;
        const changed=getComputedStyle(el).position==='static';if(changed)el.style.position='relative';
        const charge=document.createElement('span');charge.className='nuvex-device-charge';charge.setAttribute('aria-hidden','true');el.append(charge);
        charge.style.animationDelay=delay+'ms';charge.style.setProperty('--charge-delay',delay+'ms');
        const animation=charge.animate([{opacity:0},{opacity:1,offset:.25},{opacity:.8,offset:.65},{opacity:0}],{duration:1100,delay,fill:'backwards'});
        animations.push(animation);
        const cleanup=()=>{charge.remove();if(changed && el.style.position==='relative')el.style.position=oldPosition;};
        animation.onfinish=cleanup;animation.oncancel=cleanup;
      });
    }
    function reveal() {
      const page=host.querySelector('section.page');if(!page || page===current)return;
      current=page;animations.forEach(animation=>animation.cancel());animations=[];
      deviceSeen=new WeakSet();deviceIndex=0;deviceUntil=performance.now()+2500;
      if(reduced.matches || !page.animate)return;
      revealDevices();
    }
    // Observe only page replacement: live device status updates do not replay the entrance.
    new MutationObserver(reveal).observe(host,{childList:true});reveal();
    new MutationObserver(()=>{
      if(performance.now()<=deviceUntil && !deviceFrame)deviceFrame=requestAnimationFrame(revealDevices);
    }).observe(host,{childList:true,subtree:true});
    reduced.addEventListener('change',()=>{if(reduced.matches){animations.forEach(animation=>animation.cancel());animations=[];}});
  }
  function animatedCanvas(host, draw) {
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'nuvex-electric-canvas'; canvas.setAttribute('aria-hidden','true');host.append(canvas);
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    let width=0,height=0,frame=0,last=0;
    const resize = () => {
      const r=host.getBoundingClientRect();width=r.width;height=r.height;
      const ratio=Math.min(devicePixelRatio || 1,2);
      canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
      ctx.setTransform(ratio,0,0,ratio,0,0);
    };
    new ResizeObserver(resize).observe(host);resize();
    function tick(now) {
      frame=0;
      if(document.hidden || reduced.matches) {ctx.clearRect(0,0,width,height);return;}
      if(now-last>33) {
        last=now;ctx.clearRect(0,0,width,height);
        if(width && height && !host.closest('[inert]')) draw(ctx,width,height,now/1000);
      }
      frame=requestAnimationFrame(tick);
    }
    function resume(){if(!frame)frame=requestAnimationFrame(tick);}
    document.addEventListener('visibilitychange',resume);reduced.addEventListener('change',resume);resume();
  }
  function animateElectricity(host) {
    animatedCanvas(host,(ctx,w,h,t)=>{
      // Match the contained 2048 × 730 logo instead of drawing over its transparent margins.
      const scale=Math.min(w/2048,h/730),lw=2048*scale,lh=730*scale;
      ctx.save();ctx.translate((w-lw)/2,(h-lh)/2);ctx.scale(lw,lh);
      ctx.lineCap='round';
      for(let lane=0;lane<7;lane++) {
        const orange=lane%2===1,phase=lane*.8;
        const point=x=>[x,.50+Math.sin(x*Math.PI*5+phase)*(.07+lane*.006)+Math.sin(x*21+phase)*.025];
        for(let pulse=0;pulse<3;pulse++) {
          const head=((t*(orange?.13:.18)+pulse/3+lane*.11)%1.16)-.08;
          ctx.beginPath();
          for(let step=0;step<24;step++) {
            const x=head-step*.003;if(x<0||x>1)continue;
            const [px,py]=point(x);if(step===0)ctx.moveTo(px,py);else ctx.lineTo(px,py);
          }
          ctx.strokeStyle=orange?'rgba(255,154,35,.75)':'rgba(30,202,255,.85)';
          ctx.lineWidth=.002;ctx.shadowColor=orange?'#ff8b12':'#00c8ff';ctx.shadowBlur=8;ctx.stroke();
          if(head>=0 && head<=1){const [x,y]=point(head);ctx.fillStyle='#eaffff';ctx.beginPath();ctx.ellipse(x,y,.003,.008,0,0,Math.PI*2);ctx.fill();}
        }
      }
      // Electric charges circulate around the blue/orange ring.
      for(let i=0;i<5;i++){
        const angle=t*.9+i*Math.PI*2/5,x=.485+Math.cos(angle)*.157,y=.49+Math.sin(angle)*.43;
        ctx.shadowColor=i%2?'#ff9518':'#00bfff';ctx.shadowBlur=10;ctx.fillStyle=i%2?'#ffdf9b':'#b8f6ff';
        ctx.beginPath();ctx.ellipse(x,y,.0025,.007,0,0,Math.PI*2);ctx.fill();
      }
      ctx.restore();
    });
  }
  document.addEventListener('visibilitychange', () => document.body.classList.toggle('motion-paused', document.hidden));
})();

'use strict';
(async()=>{
 const response=await fetch('/_cloud/session',{cache:'no-store'});if(!response.ok)return;
 const session=await response.json();window.NUVEX_CLOUD_REMOTE=true;
 const current=(session.systems||[]).find(system=>system.id===session.selected);
 const original=document.getElementById('portalLogout');
 if(!original)return;
 const logout=original.cloneNode(true);original.replaceWith(logout);
 logout.title='Uitloggen bij Nuvex Cloud';
 logout.onclick=async()=>{logout.disabled=true;const r=await fetch('/_cloud/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'});if(r.ok)location.replace('/');else logout.disabled=false;};
 const cloud=document.createElement((session.systems||[]).length>1?'a':'span');
 cloud.className='nuvex-cloud-connected';
 cloud.innerHTML='<span class="nuvex-cloud-dot"></span><span class="nuvex-cloud-globe" aria-hidden="true">🌐</span><span>Cloud</span>';
 cloud.title='Verbonden via Nuvex Cloud'+(current?' · '+current.name:'')+((session.systems||[]).length>1?' · Klik om een ander systeem te kiezen':'');
 if(cloud.tagName==='A')cloud.href='/_cloud/choose';
 logout.before(cloud);
})().catch(()=>{});

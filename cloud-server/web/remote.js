'use strict';
(async()=>{
 const response=await fetch('/_cloud/session',{cache:'no-store'});if(!response.ok)return;
 const session=await response.json(),bar=document.createElement('nav');bar.className='nuvex-cloud-bar';bar.setAttribute('aria-label','Cloudverbinding');
 const choose=document.createElement('a');choose.href='/_cloud/choose';choose.textContent='Systeem kiezen';
 const logout=document.createElement('button');logout.textContent='Cloud uitloggen';logout.type='button';logout.onclick=async()=>{logout.disabled=true;const r=await fetch('/_cloud/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'});if(r.ok)location.replace('/');else logout.disabled=false;};
 bar.append(choose,logout);document.body.append(bar);
})().catch(()=>{});

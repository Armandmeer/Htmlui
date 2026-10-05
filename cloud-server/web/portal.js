'use strict';
let csrf='';
const $=id=>document.getElementById(id);
async function api(path,body){
 const response=await fetch('/_cloud/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const data=await response.json();if(!response.ok)throw Error(data.error||'Verbinding mislukt.');return data;
}
function showSystems(data){
 csrf=data.csrf;$('login').hidden=true;$('choices').hidden=false;$('title').textContent='Kies je systeem';$('subtitle').textContent='Met welk Nuvex-systeem wil je verbinden?';$('systems').replaceChildren();
 for(const system of data.systems){const button=document.createElement('button');button.type='button';button.className='system-option';button.textContent=system.name;button.onclick=async()=>{button.disabled=true;try{await api('select',{id:system.id});location.replace('/');}catch(e){$('error').textContent=e.message;button.disabled=false;}};$('systems').append(button);}
}
$('eye').onclick=()=>{$('password').type=$('password').type==='password'?'text':'password';};
$('login').onsubmit=async e=>{
 e.preventDefault();$('submit').disabled=true;$('error').textContent='Verbinding controleren…';
 try{const data=await api('login',{email:$('email').value.trim(),password:$('password').value});$('password').value='';$('error').textContent='';if(data.selected)location.replace('/');else showSystems(data);}
 catch(e){$('password').value='';$('error').textContent=e.message;}finally{$('submit').disabled=false;}
};
$('logout').onclick=async()=>{try{await api('logout',{});location.replace('/');}catch(e){$('error').textContent=e.message;}};
api('session').then(showSystems).catch(()=>{});

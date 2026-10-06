'use strict';
const fs=require('node:fs'),path=require('node:path'),https=require('node:https');
const {spawnSync}=require('node:child_process');
const WebSocket=require('ws');
const dir=__dirname;
async function main(){
  console.log('Nuvex Cloud Access - verbindingscontrole');
  const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const source=fs.readFileSync(path.join(dir,'server.js'),'utf8');
  console.log('Versie op schijf:',pkg.version);
  console.log('Servercode bevat remote verbinding:',source.includes('remote:remoteAccess')?'ja':'nee');
  console.log('server.js laatst gewijzigd:',fs.statSync(path.join(dir,'server.js')).mtime.toISOString());
  if(process.platform==='win32'){
    const command="Get-NetTCPConnection -LocalPort 3010 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_) } | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress";
    const result=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true});
    if(result.stdout.trim())console.log('Draaiend proces op poort 3010:',result.stdout.trim());
  }
  const file=path.join(dir,'nuvex_cloud_access.json');
  if(!fs.existsSync(file)){console.log('Geen actieve cloudconfiguratie in deze map. Controleer of dit de juiste Nuvex-map is.');return;}
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  const base=new URL(config.url);
  if(base.protocol!=='https:' || base.username || base.password)throw Error('Ongeldig cloudadres');
  console.log('Cloudadres:',base.origin);
  const users=JSON.parse(fs.readFileSync(path.join(dir,'users.json'),'utf8')).users||[];
  const admin=users.find(u=>u.role==='admin' && !u.disabled);
  if(!admin)throw Error('Geen actieve admin in deze map');
  const accounts=users.map(u=>({email:String(u.email).trim().toLowerCase(),role:u.role==='admin'?'admin':'user',disabled:u.disabled===true}));
  const payload=JSON.stringify({name:config.name,version:pkg.version,firstRegisteredEmail:config.firstEmail,adminEmail:admin.email,accounts});
  let ca=config.ca;
  const publicCa=path.join(dir,'nuvex-cloud-ca.pem');
  if(base.hostname==='192.168.40.119' && fs.existsSync(publicCa))ca=fs.readFileSync(publicCa,'utf8');
  const response=await new Promise((resolve,reject)=>{
    const req=https.request(new URL('/device/heartbeat',base),{method:'POST',rejectUnauthorized:true,...(ca?{ca}:{}),headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;if(body.length>131072)req.destroy(Error('Antwoord te groot'));});
      res.on('end',()=>{console.log('Registratieverbinding HTTP:',res.statusCode);if(res.statusCode!==200)return reject(Error('Registratiesleutel niet geaccepteerd of cloudserver niet bereikbaar'));try{resolve(JSON.parse(body));}catch(_){reject(Error('Ongeldig antwoord'));}});
      res.on('error',reject);
    });req.setTimeout(15000,()=>req.destroy(Error('Registratieverbinding timeout')));req.on('error',reject);req.end(payload);
  });
  console.log('Cloudserver staat remote verbinding toe:',response.remoteAccessEnabled?'ja':'nee');
  if(!response.remoteAccessEnabled){console.log('Gebruik de vernieuwde cloudgateway; een online registratie alleen is onvoldoende.');return;}
  const target=new URL('/device/relay',base);target.protocol='wss:';
  await new Promise(resolve=>{
    const ws=new WebSocket(target,{headers:{Authorization:'Bearer '+config.token},rejectUnauthorized:true,...(ca?{ca}:{}),handshakeTimeout:15000,perMessageDeflate:false});
    const timer=setTimeout(()=>{console.log('Remote WebSocket: timeout');ws.terminate();resolve();},18000);
    ws.on('open',()=>{console.log('Remote WebSocket: verbinding geslaagd');clearTimeout(timer);ws.close();resolve();});
    ws.on('error',e=>{console.log('Remote WebSocket fout:',e.code||e.message);clearTimeout(timer);resolve();});
    ws.on('close',()=>clearTimeout(timer));
  });
  console.log('Controle klaar. Deel deze uitvoer; er staan geen wachtwoorden of sleutels in.');
}
main().catch(error=>{console.log('Controle gestopt:',error.code||error.message);process.exitCode=1;});

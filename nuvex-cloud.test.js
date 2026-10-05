'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CloudAccess} = require('./nuvex-cloud');
function fixture(request) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'nuvex-cloud-'));
  const users = [{email:'first@example.com',role:'admin'},{email:'other@example.com',role:'user'}];
  const manager = new CloudAccess({directory,readUsers:()=>users,version:'3.0',interval:3600000,request});
  return {directory,manager,clean(){manager.stop();fs.rmSync(directory,{recursive:true,force:true});}};
}
test('default address, registration, heartbeat and disable remove credentials',async()=>{
  const calls=[],f=fixture(async(c,r,b,t)=>{calls.push({c,r,b,t});return r==='/device/enroll'?{id:'test'}:{};});
  try {
    await f.manager.setEnabled(true,'first@example.com');
    await f.manager.heartbeat();
    assert.equal(calls[0].c.url,'https://cloud.nuvexai.nl');
    assert.match(calls[0].b.registrationKey,/^[A-Za-z0-9_-]{64}$/);
    assert.deepEqual(calls[0].b.accounts,[{email:'first@example.com',role:'admin',disabled:false},{email:'other@example.com',role:'user',disabled:false}]);
    assert.equal(calls[1].t,calls[0].b.registrationKey);
    assert(!JSON.stringify(f.manager.status()).includes(calls[0].b.registrationKey));
    await f.manager.setEnabled(false);
    assert(!fs.existsSync(f.manager.file));assert.equal(f.manager.status().url,'https://cloud.nuvexai.nl');
  } finally {f.clean();}
});
test('temporary address is restored offline, address changes rotate keys',async()=>{
  const calls=[],f=fixture(async(c,r)=>{calls.push({url:c.url,token:c.token,r});return r==='/device/enroll'?{id:'test'}:{};});
  try {
    await f.manager.setEnabled(true,'first@example.com','test.trycloudflare.com');
    const key=f.manager.config.token;f.manager.stop();f.manager.start();
    assert.equal(f.manager.config.url,'https://test.trycloudflare.com');assert.equal(f.manager.config.token,key);
    await f.manager.setEnabled(true,'first@example.com','https://next.trycloudflare.com');
    assert.equal(calls[0].r,'/device/disable');assert.equal(calls[0].url,'https://test.trycloudflare.com');
    assert.notEqual(f.manager.config.token,key);assert.equal(f.manager.config.url,'https://next.trycloudflare.com');
    await f.manager.setEnabled(false);
  } finally {f.clean();}
});
test('invalid URL does not change an active connection',async()=>{
  const f=fixture(async()=>({}));
  try {await f.manager.setEnabled(true,'first@example.com');const key=f.manager.config.token;
    for (const url of ['http://evil.example','https://a:b@example.com','https://example.com/path','https://example.com/?x=1']) await assert.rejects(f.manager.setEnabled(true,'first@example.com',url));
    assert.equal(f.manager.config.token,key);await f.manager.setEnabled(false);
  } finally {f.clean();}
});
test('late response cannot restore state after disable',async()=>{
  let resolve;const f=fixture(async(c,r)=>r==='/device/enroll'?new Promise(done=>{resolve=done;}):{});
  try {await f.manager.setEnabled(true,'first@example.com');const pending=f.manager.heartbeat();await f.manager.setEnabled(false);resolve({id:'late'});await pending;assert(!fs.existsSync(f.manager.file));assert.equal(f.manager.status().enabled,false);}
  finally {f.clean();}
});

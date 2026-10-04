const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
function fixture(){
 let config=null,calls=[];
 const api={};const context={module:{exports:api},require:name=>name==='fs'?{readFileSync:()=>{if(!config)throw Error();return JSON.stringify(config);},writeFileSync:(_,value)=>config=JSON.parse(value)}:require(name),Map,Date,Intl,URL,URLSearchParams,AbortSignal,fetch:async url=>{
  calls.push(String(url));let data;
  if(String(url).includes('ipwho'))data={success:true,city:'Rotterdam',latitude:51.92,longitude:4.48};
  else if(String(url).includes('geocoding'))data={results:[{id:1,name:'Utrecht',country:'Nederland',latitude:52.09,longitude:5.12}]};
  else data={actual:{stationmeasurements:[{stationname:'Ver weg',lat:53.2,lon:6.6,temperature:5,timestamp:new Date().toISOString()},{stationname:'Rotterdam',lat:51.96,lon:4.45,temperature:0,timestamp:new Date().toISOString()}]}};
  return {ok:true,json:async()=>data};
 },__dirname:__dirname};vm.runInNewContext(fs.readFileSync('weather.js','utf8'),context);return {api:context.module.exports,calls,config:()=>config};
}
test('auto location, nearest station, zero temperature, feed caching',async()=>{const f=fixture();const d=await f.api.getWeather({},false);assert.equal(d.temperature,0);assert.equal(d.station,'Rotterdam');assert.equal(f.config().mode,'auto');await f.api.getWeather({},false);assert.equal(f.calls.length,2);});
test('KNX priority, negative temperatures, waiting and offline',async()=>{const f=fixture(),state={deviceDrivers:[{id:'w',category:'weather'}],genericDevices:[{id:'1',driverId:'w',outdoorTemperatureGa:'1/2/3'}]};assert.equal((await f.api.getWeather(state,true)).status,'waiting');f.api.record('1/2/3',-3.5);assert.equal((await f.api.getWeather(state,true)).temperature,-3.5);assert.equal((await f.api.getWeather(state,false)).status,'offline');assert.equal(f.calls.length,0);});
test('manual location requires selecting a result and persists',async()=>{const f=fixture();const found=await f.api.save({name:'Utrecht'});assert.equal(found.candidates.length,1);assert.equal(f.config(),null);await f.api.save({name:'Utrecht',locationId:1});assert.equal(f.config().mode,'manual');assert.equal((await f.api.settings({})).latitude,52.09);assert.equal(f.calls.some(c=>c.includes('ipwho')),false);});
test('Buienradar local times convert correctly in summer and winter',()=>{const f=fixture();assert.equal(f.api.measuredAt('2026-07-01T12:00:00'),'2026-07-01T10:00:00.000Z');assert.equal(f.api.measuredAt('2026-12-01T12:00:00'),'2026-12-01T11:00:00.000Z');});

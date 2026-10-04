const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('index.html','utf8');
const visibility=html.match(/updateSidebarVisibility=function\(\)\{[^\n]+/)[0];
function check({energy='<section class="page" id="energy"></section>',generic=[],lighting=[],security=[],active='home'}={}){
 const kinds=['lighting','screen','av','camera','thermostat','security','energy','automation','scene'];
 const buttons=kinds.map(kind=>({dataset:{navKind:kind},hidden:false,setAttribute(){},style:{removeProperty(){},setProperty(){}}}));
 const activeButton=buttons.find(b=>b.dataset.navKind===active);let redirected=null;
 const context={genericDevices:()=>generic,sliders:()=>lighting,securityDevices:()=>security,rooms:()=>[],pageTemplates:{energy},currentPageId:active,
 document:{querySelectorAll:()=>buttons,querySelector:selector=>selector.includes('.active')?activeButton:{}},showPage:id=>redirected=id};
 vm.runInNewContext(visibility+';updateSidebarVisibility();',context);
 return {buttons:Object.fromEntries(buttons.map(b=>[b.dataset.navKind,!b.hidden])),redirected};
}
test('empty energy and device pages are excluded; useful automation controls remain',()=>{
 const result=check();assert.equal(result.buttons.energy,false);assert.equal(result.buttons.lighting,false);assert.equal(result.buttons.camera,false);assert.equal(result.buttons.automation,true);
});
test('configured pages and implemented energy content become available',()=>{
 const result=check({lighting:[{}],security:[{}],generic:[{type:'camera'}],energy:'<section id="energy"><div>Meter readings</div></section>'});
 assert.equal(result.buttons.energy,true);assert.equal(result.buttons.lighting,true);assert.equal(result.buttons.camera,true);assert.equal(result.buttons.security,true);
});
test('a page that becomes unavailable returns to overview',()=>assert.equal(check({active:'energy'}).redirected,'home'));
test('all inline page scripts parse',()=>{for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);});
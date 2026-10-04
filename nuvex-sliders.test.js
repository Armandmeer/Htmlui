const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('nuvex-motion.js','utf8');
const start=source.indexOf('  function enhanceSliders(){'),end=source.indexOf('  function animatePages()',start);
function setup(options={}){
  const listeners={},events=[],styles={};let capture=null;
  const input={min:'0',max:'100',step:'1',value:'20',disabled:false,dataset:{},
    style:{setProperty:(key,value)=>styles[key]=value},
    getBoundingClientRect:()=>({left:10,width:200}),focus:()=>{},
    setPointerCapture:id=>capture=id,hasPointerCapture:id=>capture===id,releasePointerCapture:()=>capture=null,
    dispatchEvent:event=>{events.push(event.type);if(event.type==='input')listeners.input({target:input});},
    matches:()=>true,closest:()=>input,...options};
  const host={addEventListener:(name,fn)=>listeners[name]=fn,querySelectorAll:()=>[input]};
  vm.runInNewContext('('+source.slice(start,end)+')()',{
    document:{getElementById:()=>host},MutationObserver:class{observe(){}},Event:class{constructor(type){this.type=type;}},
    getComputedStyle:()=>({direction:options.direction||'ltr'})
  });
  function fire(type,x,id=1){listeners[type]({type,target:input,clientX:x,pointerId:id,isPrimary:true,button:0,preventDefault(){}});}
  return {input,events,styles,fire};
}
test('drag starts anywhere on the bar and continues outside its bounds',()=>{
 const s=setup();s.fire('pointerdown',110);assert.equal(s.input.value,'50');assert.equal(s.input.dataset.nuvexDragging,'true');
 s.fire('pointermove',170);assert.equal(s.input.value,'80');
 s.fire('pointermove',400);assert.equal(s.input.value,'100');s.fire('pointerup',400);
 assert.equal(s.styles['--fill'],'100%');assert.equal(s.input.dataset.nuvexDragging,undefined);
 assert.deepEqual(s.events,['input','input','input','change']);
});
test('temperature steps, cancellation and other fingers are handled',()=>{
 const s=setup({min:'5',max:'35',step:'0.5',value:'20'});s.fire('pointerdown',113);assert.equal(s.input.value,'20.5');
 s.fire('pointermove',210,2);assert.equal(s.input.value,'20.5');s.fire('pointercancel',113);
 assert.equal(s.events.at(-1),'change');assert.equal(s.input.dataset.nuvexDragging,undefined);
});
test('disabled sliders cannot be dragged; RTL bars run in reverse',()=>{
 const disabled=setup({disabled:true});disabled.fire('pointerdown',150);assert.equal(disabled.input.value,'20');assert.deepEqual(disabled.events,[]);
 const rtl=setup({direction:'rtl'});rtl.fire('pointerdown',10);assert.equal(rtl.input.value,'100');rtl.fire('pointerup',210);assert.equal(rtl.input.value,'0');
});
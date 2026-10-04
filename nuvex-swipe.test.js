const test=require('node:test'),assert=require('node:assert/strict');
const {direction}=require('./nuvex-swipe');
const start={x:200,y:200,time:0};
test('left advances and right goes back',()=>{assert.equal(direction(start,{x:100,y:205,time:250},390),1);assert.equal(direction(start,{x:300,y:195,time:250},390),-1);});
test('vertical, short, slow and diagonal gestures do not navigate',()=>{for(const end of [{x:190,y:350,time:250},{x:160,y:200,time:250},{x:90,y:200,time:1200},{x:100,y:285,time:250}])assert.equal(direction(start,end,390),0);});
test('larger screens require a deliberate swipe',()=>{assert.equal(direction(start,{x:100,y:200,time:250},1200),0);assert.equal(direction(start,{x:60,y:200,time:250},1200),1);});

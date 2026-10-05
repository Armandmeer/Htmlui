'use strict';
const http = require('node:http');
const WebSocket = require('ws');
const MAX_BODY = 8*1024*1024, MAX_RESPONSE = 16*1024*1024;
class RemoteAccess {
  constructor({port,profile,grant}) {
    this.port=port;this.profile=profile;this.grant=grant;
    this.socket=null;this.config=null;this.timer=null;this.sockets=new Map();this.requests=new Set();
    this.alive=false;this.pingTimer=null;
  }
  connected(){return !!this.socket && this.socket.readyState===WebSocket.OPEN;}
  start(config,ca){
    if(this.config && this.config.token===config.token && this.config.url===config.url && (this.socket||this.timer))return;
    this.stop();this.config=config;this.ca=ca;this.connect();
  }
  connect(){
    const config=this.config;if(!config)return;
    const url=new URL('/device/relay',config.url);url.protocol='wss:';
    const socket=new WebSocket(url,{headers:{Authorization:'Bearer '+config.token},rejectUnauthorized:true,...(this.ca?{ca:this.ca}:{}),handshakeTimeout:15000,maxPayload:24*1024*1024,perMessageDeflate:false});
    this.socket=socket;
    socket.on('open',()=>{
      this.alive=true;
      this.pingTimer=setInterval(()=>{if(!this.alive)return socket.terminate();this.alive=false;socket.ping();},25000);this.pingTimer.unref();
    });
    socket.on('pong',()=>{this.alive=true;});
    socket.on('message',raw=>{let data;try{data=JSON.parse(raw);}catch(_){return socket.close(1008);}
      this.handle(data,socket).catch(()=>this.reply(socket,{requestId:data.requestId,error:true}));
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{
      if(this.socket!==socket)return;
      clearInterval(this.pingTimer);this.pingTimer=null;this.socket=null;this.clearLocal();
      if(this.config){this.timer=setTimeout(()=>{this.timer=null;this.connect();},5000);this.timer.unref();}
    });
  }
  reply(socket,data){if(socket.readyState===WebSocket.OPEN && socket.bufferedAmount<24*1024*1024)socket.send(JSON.stringify(data));else socket.terminate();}
  validCookie(cookie){return typeof cookie==='string' && /^htmlui_session=[a-f0-9]{64}$/.test(cookie);}
  async handle(data,socket){
    if(this.socket!==socket || !this.config || !data || typeof data!=='object')return;
    if(data.type==='auth-profile')return this.reply(socket,{requestId:data.requestId,...this.profile(data.email)});
    if(data.type==='auth-grant')return this.reply(socket,{requestId:data.requestId,...this.grant(data.ticket)});
    if(data.type==='http'){
      if(!this.validCookie(data.cookie) || this.requests.size>=48)throw Error('invalid');
      if(typeof data.path!=='string' || !data.path.startsWith('/') || data.path.startsWith('//') || /[\r\n\\]/.test(data.path))throw Error('invalid path');
      // The relay only accesses this Nuvex process, never arbitrary LAN addresses.
      if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(data.method))throw Error('invalid method');
      if(typeof data.body!=='string' || data.body.length>MAX_BODY*1.4)throw Error('too large');
      const body=Buffer.from(data.body,'base64');if(body.length>MAX_BODY)throw Error('too large');
      const headers={Cookie:data.cookie,Host:'127.0.0.1:'+this.port,Origin:'http://127.0.0.1:'+this.port,'Content-Length':body.length,'Accept-Encoding':'identity'};
      for(const [k,v] of Object.entries(data.headers||{}))if(['content-type','range','x-settings-token','x-csrf-token'].includes(k.toLowerCase()) && typeof v==='string' && !/[\r\n]/.test(v))headers[k]=v;
      return new Promise((resolve,reject)=>{
        const req=http.request({hostname:'127.0.0.1',port:this.port,path:data.path,method:data.method,headers},res=>{
          let size=0;const chunks=[];
          res.on('data',chunk=>{size+=chunk.length;if(size>MAX_RESPONSE)req.destroy(Error('too large'));else chunks.push(chunk);});
          res.on('error',reject);
          res.on('end',()=>{
            const result={};for(const [k,v] of Object.entries(res.headers))if(['content-type','location','content-range','accept-ranges'].includes(k) && typeof v==='string')result[k]=v;
            this.reply(socket,{requestId:data.requestId,status:res.statusCode,headers:result,body:Buffer.concat(chunks).toString('base64')});resolve();
          });
        });
        this.requests.add(req);req.on('close',()=>this.requests.delete(req));req.on('error',reject);req.setTimeout(23000,()=>req.destroy(Error('timeout')));req.end(body);
      });
    }
    if(data.type==='ws-open'){
      if(!this.validCookie(data.cookie) || typeof data.channel!=='string' || this.sockets.size>=128)throw Error('invalid');
      const ws=new WebSocket('ws://127.0.0.1:'+this.port+'/ws',{headers:{Cookie:data.cookie},handshakeTimeout:10000,maxPayload:1024*1024,perMessageDeflate:false});
      this.sockets.set(data.channel,ws);
      ws.on('open',()=>this.reply(socket,{requestId:data.requestId,ok:true}));
      ws.on('message',(body,binary)=>this.reply(socket,{type:'ws-data',channel:data.channel,body:body.toString('base64'),binary}));
      ws.on('error',()=>this.reply(socket,{requestId:data.requestId,error:true}));
      ws.on('close',()=>{this.sockets.delete(data.channel);this.reply(socket,{type:'ws-close',channel:data.channel});});
      return;
    }
    const ws=this.sockets.get(data.channel);
    if(data.type==='ws-data' && ws && ws.readyState===WebSocket.OPEN){
      if(typeof data.body!=='string' || data.body.length>1500000)throw Error('too large');
      ws.send(Buffer.from(data.body,'base64'),{binary:!!data.binary});
    }
    if(data.type==='ws-close' && ws)ws.terminate();
  }
  clearLocal(){for(const req of this.requests)req.destroy();this.requests.clear();for(const ws of this.sockets.values())ws.terminate();this.sockets.clear();}
  stop(){this.config=null;clearTimeout(this.timer);this.timer=null;clearInterval(this.pingTimer);this.pingTimer=null;const socket=this.socket;this.socket=null;if(socket)socket.terminate();this.clearLocal();}
}
module.exports={RemoteAccess};

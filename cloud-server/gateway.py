"""Browser portal and authenticated outbound relay for Nuvex Cloud Access."""
import asyncio, base64, hashlib, hmac, json, secrets, threading, time, ipaddress
from http.cookies import SimpleCookie
from pathlib import Path
from aiohttp import web, ClientSession, ClientTimeout, DummyCookieJar, WSMsgType
import server

MAX_BODY = 8 * 1024 * 1024
MAX_FRAME = 24 * 1024 * 1024
COOKIE = 'nuvex_portal'
PREFIX = '/_cloud/'
SECURITY = {'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY'}

def source_ip(req):
    candidates=[req.headers.get('CF-Connecting-IP',''),req.headers.get('X-Nuvex-Source-IP',''),req.headers.get('X-Real-IP',''),req.headers.get('X-Forwarded-For','').split(',')[0].strip(),req.remote or '']
    for candidate in candidates:
        try:return str(ipaddress.ip_address(candidate))
        except ValueError:continue
    return ''

class Device:
    def __init__(self, sid, ws):
        self.sid, self.ws = sid, ws
        self.pending = {}
        self.browsers = {}
    async def call(self, operation, **data):
        if self.ws.closed or len(self.pending) >= 48: raise web.HTTPServiceUnavailable(text='Systeem niet beschikbaar.')
        rid = secrets.token_urlsafe(18)
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            await self.ws.send_json({'type':operation,'requestId':rid,**data})
            return await asyncio.wait_for(future,25)
        except asyncio.TimeoutError: raise web.HTTPGatewayTimeout(text='Systeem reageert niet.')
        finally: self.pending.pop(rid,None)
    async def close(self):
        await self.ws.close()
        for f in list(self.pending.values()):
            if not f.done(): f.set_exception(web.HTTPServiceUnavailable(text='Systeemverbinding verbroken.'))
        for ws in list(self.browsers.values()): await ws.close()

class Portal:
    def __init__(self, backend='http://127.0.0.1:8082'):
        self.backend = backend
        self.devices = {}
        self.sessions = {}
        self.http = None
        self.logins = asyncio.Semaphore(8)
    def origin_allowed(self, req):
        origin = req.headers.get('Origin')
        return origin in ({server.ORIGIN}|server.ALLOWED_ORIGINS) or server.TUNNEL.allows(origin)
    def state(self, req):
        key = server.digest(req.cookies.get(COOKIE,''))
        s = self.sessions.get(key)
        if s and s['expires'] > time.time(): return s
        self.sessions.pop(key,None)
        return None
    def active(self,s):
        sid = s.get('selected')
        with server.connect() as c:
            row = c.execute('SELECT revoked,accounts FROM systems WHERE id=?',(sid,)).fetchone()
        if not row or row['revoked'] or not any(x['email']==s['email'] and not x.get('disabled') for x in json.loads(row['accounts'])):
            raise web.HTTPUnauthorized(text='Toegang ingetrokken. Log opnieuw in.')
        if sid not in self.devices: raise web.HTTPServiceUnavailable(text='Het Nuvex-systeem is offline.')
        return self.devices[sid]
    async def relay(self, req):
        auth = req.headers.get('Authorization','')
        with server.connect() as c:
            row = c.execute('''SELECT systems.id,systems.mac_address FROM systems JOIN allowed_macs ON allowed_macs.mac=systems.mac_address WHERE systems.token=? AND systems.revoked=0''',(server.digest(auth[7:]) if auth.startswith('Bearer ') else '',)).fetchone()
        if not row: raise web.HTTPUnauthorized()
        sid, remote_ip = row['id'], source_ip(req)
        ws = web.WebSocketResponse(heartbeat=20,max_msg_size=MAX_FRAME,compress=False)
        await ws.prepare(req)
        old = self.devices.get(sid)
        if old: await old.close()
        device = Device(sid,ws); self.devices[sid] = device
        with server.connect() as c:server.audit(c,'relay.connected',sid,remote_ip,row['mac_address'])
        async def check():
            while not ws.closed:
                await asyncio.sleep(5)
                with server.connect() as c: valid = c.execute('SELECT 1 FROM systems WHERE id=? AND revoked=0',(sid,)).fetchone()
                if not valid: await ws.close(code=1008)
        monitor = asyncio.create_task(check())
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT: continue
                try: data = json.loads(message.data)
                except (ValueError,TypeError): await ws.close(code=1008); break
                if not isinstance(data,dict): await ws.close(code=1008);break
                rid = data.get('requestId'); future = device.pending.get(rid)
                if future and not future.done():
                    if data.get('error'): future.set_exception(web.HTTPBadGateway(text='Systeem kon het verzoek niet uitvoeren.'))
                    else: future.set_result(data)
                target = device.browsers.get(data.get('channel'))
                if target and not target.closed:
                    if data.get('type') == 'ws-data':
                        body = base64.b64decode(data.get('body',''),validate=True)
                        if data.get('binary'): await target.send_bytes(body)
                        else: await target.send_str(body.decode('utf-8'))
                    elif data.get('type') == 'ws-close': await target.close()
        finally:
            monitor.cancel()
            if self.devices.get(sid) is device: self.devices.pop(sid,None)
            await device.close()
            with server.connect() as c:server.audit(c,'relay.disconnected',sid,remote_ip,row['mac_address'])
        return ws
    async def login(self,req):
        if not self.origin_allowed(req): raise web.HTTPForbidden(text='Ongeldige origin.')
        if req.content_length is None or req.content_length>4096:raise web.HTTPRequestEntityTooLarge(max_size=4096,actual_size=req.content_length or 0)
        if len(self.sessions) >= 1000: raise web.HTTPServiceUnavailable()
        try: data = await req.json()
        except (ValueError,TypeError): raise web.HTTPBadRequest()
        email = str(data.get('email','')).strip().lower(); password = str(data.get('password',''))
        if not 1 <= len(email) <= 254 or '@' not in email or not 1 <= len(password) <= 1024: raise web.HTTPUnauthorized(text='E-mailadres of wachtwoord onjuist, of systeem offline.')
        now = int(time.time())
        # Account limit cannot be bypassed using spoofed forwarding headers or a new client IP.
        with server.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            for key in ('portal:'+server.digest(email),'portal:global'):
                limit = 10 if key != 'portal:global' else 300
                row=c.execute('SELECT * FROM attempts WHERE key=?',(key,)).fetchone()
                if row and row['reset']>now and row['count']>=limit: raise web.HTTPTooManyRequests(text='Probeer over 15 minuten opnieuw.')
                count=row['count']+1 if row and row['reset']>now else 1
                c.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',(key,count,row['reset'] if row and row['reset']>now else now+900))
            rows = [dict(r) for r in c.execute('SELECT id,name,accounts FROM systems WHERE revoked=0')]
        registered=[r for r in rows if any(a['email']==email and not a.get('disabled') for a in json.loads(r['accounts']))]
        matches=[r for r in registered if r['id'] in self.devices]
        if registered and not matches:
            with server.connect() as c:server.audit(c,'portal.relay_unavailable',registered[0]['id'],source_ip(req))
        if len(matches)>20: raise web.HTTPServiceUnavailable(text='Te veel systemen; neem contact op met de beheerder.')
        async def authenticate(row):
            try:
                device = self.devices[row['id']]
                profile = await device.call('auth-profile',email=email)
                salt, expected, ticket = profile.get('salt',''),profile.get('passwordHash',''),profile.get('ticket','')
                if not all(isinstance(x,str) for x in (salt,expected,ticket)) or len(salt)!=32 or len(expected)!=128 or len(ticket)>128:
                    with server.connect() as c:server.audit(c,'portal.profile_unavailable',row['id'],source_ip(req))
                    return None
                try:bytes.fromhex(salt);bytes.fromhex(expected)
                except ValueError:return None
                async with self.logins:
                    actual=await asyncio.to_thread(hashlib.scrypt,password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=64*1024*1024)
                if not hmac.compare_digest(actual.hex(),expected):
                    with server.connect() as c:server.audit(c,'portal.password_mismatch',row['id'],source_ip(req))
                    return None
                reply = await device.call('auth-grant',ticket=ticket)
                cookie = reply.get('cookie','')
                if reply.get('ok') and isinstance(cookie,str) and cookie.startswith('htmlui_session=') and len(cookie)<512:
                    return row['id'],{'name':row['name'],'cookie':cookie,'device':device}
            except (web.HTTPException,KeyError):
                with server.connect() as c:server.audit(c,'portal.relay_error',row['id'],source_ip(req))
            return None
        results=await asyncio.gather(*(authenticate(r) for r in matches))
        accepted=dict(x for x in results if x)
        if not accepted:
            with server.connect() as c: server.audit(c,'portal.login_failed',ip_address=source_ip(req),detail=email)
            raise web.HTTPUnauthorized(text='E-mailadres of wachtwoord onjuist, of systeem offline.')
        # Isolate cloud administration from scripts served by a selected Nuvex system.
        with server.connect() as c:
            c.execute('DELETE FROM sessions WHERE token=?',(server.digest(req.cookies.get('session','')),))
        old=self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None)
        if old: await self.close_channels(old)
        for key,s in list(self.sessions.items()):
            if s['expires']<time.time(): self.sessions.pop(key,None)
        token=secrets.token_urlsafe(32)
        state={'email':email,'systems':accepted,'selected':next(iter(accepted)) if len(accepted)==1 else None,'csrf':secrets.token_urlsafe(32),'expires':time.time()+28800,'channels':set()}
        self.sessions[server.digest(token)]=state
        response=web.json_response(self.public(state))
        response.set_cookie(COOKIE,token,secure=not server.DEV,httponly=True,samesite='Strict',max_age=28800,path='/')
        with server.connect() as c:
            for sid in accepted: server.audit(c,'portal.login',sid,source_ip(req),detail=email)
        return response
    def public(self,s):
        return {'csrf':s['csrf'],'selected':s['selected'],'systems':[{'id':key,'name':v['name']} for key,v in s['systems'].items()]}
    async def close_channels(self,s):
        for ws in list(s['channels']): await ws.close()
    async def portal_api(self,req):
        if req.path == PREFIX+'login' and req.method=='POST': return await self.login(req)
        s=self.state(req)
        if not s: raise web.HTTPUnauthorized(text='Log eerst in.')
        if req.method=='GET' and req.path==PREFIX+'session': return web.json_response(self.public(s))
        if req.method!='POST' or not self.origin_allowed(req) or not secrets.compare_digest(req.headers.get('X-CSRF-Token',''),s['csrf']): raise web.HTTPForbidden()
        if req.path==PREFIX+'logout':
            self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None);await self.close_channels(s)
            response=web.json_response({});response.del_cookie(COOKIE,path='/');return response
        if req.path==PREFIX+'select':
            data=await req.json();sid=data.get('id')
            if sid not in s['systems']: raise web.HTTPForbidden()
            await self.close_channels(s)
            s['selected']=sid;self.active(s)
            with server.connect() as c:server.audit(c,'portal.system_selected',sid)
            return web.json_response({'selected':sid})
        raise web.HTTPNotFound()
    async def proxy_system(self,req,s):
        device=self.active(s)
        selected=s['systems'][s['selected']]
        if selected['device'] is not device: raise web.HTTPUnauthorized(text='Systeem opnieuw verbonden; log opnieuw in.')
        if req.method not in ('GET','HEAD','POST','PUT','PATCH','DELETE'):raise web.HTTPMethodNotAllowed(req.method,[])
        if req.method not in ('GET','HEAD') and not self.origin_allowed(req):raise web.HTTPForbidden()
        if req.headers.get('Upgrade','').lower()=='websocket': return await self.browser_ws(req,s,device,selected)
        body=await req.read()
        headers={k:v for k,v in req.headers.items() if k.lower() in ('content-type','range','x-settings-token','x-csrf-token')}
        result=await device.call('http',method=req.method,path=req.raw_path,headers=headers,cookie=selected['cookie'],body=base64.b64encode(body).decode())
        status=int(result.get('status',502))
        if not 200<=status<=599:raise web.HTTPBadGateway()
        output=base64.b64decode(result.get('body',''),validate=True)
        response_headers={k:v for k,v in result.get('headers',{}).items() if k.lower() in ('content-type','content-range','accept-ranges','location')}
        location=response_headers.get('location','')
        if location and (not location.startswith('/') or location.startswith('//')): response_headers.pop('location',None)
        if req.path=='/api/auth/logout' and req.method=='POST':
            self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None);await self.close_channels(s)
        if status==401 or location=='/login.html':
            self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None);await self.close_channels(s)
        response_headers.update(SECURITY)
        if response_headers.get('content-type','').startswith('text/html') and req.path in ('/','/index.html'):
            output=output.replace(b'</body>',b'<link rel="stylesheet" href="/_portal/remote.css"><script defer src="/_portal/remote.js"></script></body>')
        return web.Response(status=status,body=output,headers=response_headers)
    async def browser_ws(self,req,s,device,selected):
        if req.path!='/ws' or not self.origin_allowed(req):raise web.HTTPForbidden()
        if len(s['channels'])>=8:raise web.HTTPTooManyRequests()
        channel=secrets.token_urlsafe(18)
        ws=web.WebSocketResponse(heartbeat=20,max_msg_size=1024*1024,compress=False)
        await ws.prepare(req);device.browsers[channel]=ws;s['channels'].add(ws)
        async def monitor():
            while not ws.closed:
                await asyncio.sleep(5)
                if self.state(req) is not s:await ws.close();return
                try:self.active(s)
                except web.HTTPException:await ws.close();return
        watcher=asyncio.create_task(monitor())
        try:
            await device.call('ws-open',channel=channel,cookie=selected['cookie'])
            async for m in ws:
                if m.type in (WSMsgType.TEXT,WSMsgType.BINARY):
                    self.active(s)
                    b=m.data.encode() if m.type==WSMsgType.TEXT else m.data
                    await device.ws.send_json({'type':'ws-data','channel':channel,'body':base64.b64encode(b).decode(),'binary':m.type==WSMsgType.BINARY})
        finally:
            watcher.cancel();device.browsers.pop(channel,None);s['channels'].discard(ws)
            if not device.ws.closed:await device.ws.send_json({'type':'ws-close','channel':channel})
            await ws.close()
        return ws
    async def backend_proxy(self,req,path):
        body=await req.read()
        headers={k:v for k,v in req.headers.items() if k.lower() in ('cookie','origin','content-type','x-csrf-token','authorization')}
        headers['X-Nuvex-Source-IP']=source_ip(req)
        async with self.http.request(req.method,self.backend+path,data=body,headers=headers,allow_redirects=False) as r:
            result=await r.read();out={k:v for k,v in r.headers.items() if k.lower() in ('content-type','set-cookie')}
            if path=='/api/systems' and r.status==200:
                rows=json.loads(result)
                for row in rows:
                    device=self.devices.get(row['id'])
                    row['remoteConnected']=bool(not row['revoked'] and device and not device.ws.closed)
                result=json.dumps(rows).encode()
            if path=='/':
                result=result.replace(b'href="/style.css"',b'href="/_admin/style.css"').replace(b'src="/app.js"',b'src="/_admin/app.js"')
            if path=='/app.js':result=result.replace(b"'/api/",b"'/_admin/api/")
            out.update(SECURITY)
            return web.Response(status=r.status,body=result,headers=out)
    async def route(self,req):
        if req.path=='/device/relay':return await self.relay(req)
        if req.path.startswith('/device/') or req.path=='/health':return await self.backend_proxy(req,req.raw_path)
        if req.path in ('/admin','/_admin/'):
            s=self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None)
            if s:await self.close_channels(s)
            return await self.backend_proxy(req,'/')
        if req.path.startswith('/_admin/'):
            if self.state(req):raise web.HTTPForbidden(text='Open de beheerlogin opnieuw.')
            path=req.raw_path[len('/_admin'):]
            if path not in ('/app.js','/style.css') and not path.startswith('/api/'):raise web.HTTPNotFound()
            return await self.backend_proxy(req,path)
        if req.path == PREFIX+'choose':
            if not self.state(req):raise web.HTTPUnauthorized()
            return web.FileResponse(server.ROOT/'web/portal.html',headers=SECURITY)
        if req.path.startswith(PREFIX):return await self.portal_api(req)
        if req.path.startswith('/_portal/'):
            assets={'/_portal/style.css':'portal.css','/_portal/app.js':'portal.js','/_portal/background.png':'portal-background.png','/_portal/logo.png':'portal-logo.png','/_portal/remote.js':'remote.js','/_portal/remote.css':'remote.css'}
            name=assets.get(req.path)
            if not name:raise web.HTTPNotFound()
            return web.FileResponse(server.ROOT/'web'/name,headers=SECURITY)
        s=self.state(req)
        if s and s['selected']:
            try:return await self.proxy_system(req,s)
            except web.HTTPUnauthorized:
                self.sessions.pop(server.digest(req.cookies.get(COOKIE,'')),None);await self.close_channels(s)
                if req.method=='GET' and req.path in ('/','/login.html'):
                    response=web.HTTPFound('/');response.del_cookie(COOKIE,path='/');return response
                raise
        if req.path in ('/','/login.html'):return web.FileResponse(server.ROOT/'web/portal.html',headers=SECURITY)
        raise web.HTTPUnauthorized(text='Log eerst in.')
    async def start(self,app):
        self.http=ClientSession(cookie_jar=DummyCookieJar(),timeout=ClientTimeout(total=30))
    async def close(self,app):
        for device in list(self.devices.values()):await device.close()
        for s in self.sessions.values():await self.close_channels(s)
        self.sessions.clear()
        await self.http.close()
    def app(self):
        @web.middleware
        async def errors(req,handler):
            try:return await handler(req)
            except web.HTTPException as e:
                if req.path.startswith(PREFIX):return web.json_response({'error':e.text},status=e.status,headers=SECURITY)
                raise
            except (ValueError,TypeError,KeyError):return web.json_response({'error':'Ongeldige invoer.'},status=400,headers=SECURITY)
        app=web.Application(client_max_size=MAX_BODY,middlewares=[errors]);app.router.add_route('*','/{path:.*}',self.route)
        app.on_startup.append(self.start);app.on_cleanup.append(self.close);return app

if __name__=='__main__':
    server.init();server.REMOTE_ACCESS=True
    if not server.DEV and not server.ORIGIN.startswith('https:'):raise SystemExit('HTTPS-origin vereist.')
    backend=server.ThreadingHTTPServer(('127.0.0.1',8082),server.Handler)
    threading.Thread(target=backend.serve_forever,daemon=True).start()
    if server.TUNNEL.config().get('enabled'):server.TUNNEL.start('fixed')
    try:web.run_app(Portal().app(),host='127.0.0.1',port=8080,access_log=None)
    finally:server.TUNNEL.stop();backend.shutdown();backend.server_close()

import unittest, tempfile, json, hashlib, secrets, asyncio, base64
from pathlib import Path
from unittest.mock import patch
from aiohttp import ClientSession, CookieJar, WSMsgType
from aiohttp.test_utils import TestServer
import server
from gateway import Portal

class PortalIntegration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.old_db=server.DB;self.old_dev=server.DEV;self.old_origin=server.ORIGIN
        server.DB=Path(self.tmp.name)/'cloud.db';server.DEV=True;server.init()
        self.portal=Portal();self.site=TestServer(self.portal.app());await self.site.start_server()
        server.ORIGIN=str(self.site.make_url('/')).rstrip('/')
        self.client=ClientSession(cookie_jar=CookieJar(unsafe=True));self.devices=[];self.tasks=[]
    async def asyncTearDown(self):
        await self.client.close()
        for device in self.devices:await device.close()
        for task in self.tasks:task.cancel()
        await self.site.close();server.DB=self.old_db;server.DEV=self.old_dev;server.ORIGIN=self.old_origin;self.tmp.cleanup()
    async def device(self,sid,email='user@example.com',password='test-password-long'):
        token=secrets.token_urlsafe(48);salt=secrets.token_hex(16)
        password_hash=hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=64*1024*1024).hex()
        accounts=[{'email':email,'role':'user','disabled':False}]
        with server.connect() as c:c.execute('INSERT INTO systems(id,name,token,first_email,admin_email,accounts,version,seen) VALUES(?,?,?,?,?,?,?,?)',(sid,'Home '+sid,server.digest(token),email,email,json.dumps(accounts),'0.4.1',0))
        ws=await self.client.ws_connect(self.site.make_url('/device/relay'),headers={'Authorization':'Bearer '+token});self.devices.append(ws)
        async def loop():
            async for message in ws:
                if message.type!=WSMsgType.TEXT:continue
                data=json.loads(message.data);self.assertNotIn('password',data)
                response={'requestId':data.get('requestId')}
                if data['type']=='auth-profile':response.update(salt=salt,passwordHash=password_hash,ticket='ticket-'+sid)
                elif data['type']=='auth-grant':response.update(ok=True,cookie='htmlui_session='+'a'*64)
                elif data['type']=='http':
                    self.assertEqual(data['cookie'],'htmlui_session='+'a'*64)
                    response.update(status=200,headers={'content-type':'text/html'},body=base64.b64encode(('<html><body>'+sid+'</body></html>').encode()).decode())
                elif data['type']=='ws-open':response['ok']=True
                elif data['type']=='ws-data':
                    await ws.send_json({'type':'ws-data','channel':data['channel'],'body':data['body'],'binary':data['binary']});continue
                else:continue
                await ws.send_json(response)
        self.tasks.append(asyncio.create_task(loop()))
        return token
    async def login(self,password='test-password-long'):
        response=await self.client.post(self.site.make_url('/_cloud/login'),json={'email':'user@example.com','password':password},headers={'Origin':server.ORIGIN})
        return response.status,await response.json()
    async def test_single_system_sso_http_and_websocket(self):
        await self.device('one');status,login=await self.login();self.assertEqual(status,200);self.assertEqual(login['selected'],'one')
        response=await self.client.get(self.site.make_url('/'));self.assertIn('one',await response.text())
        self.assertIn('/_portal/remote.js',await (await self.client.get(self.site.make_url('/'))).text())
        ws=await self.client.ws_connect(self.site.make_url('/ws'),headers={'Origin':server.ORIGIN});await ws.send_str('live-command')
        message=await ws.receive(timeout=5);self.assertEqual(message.data,'live-command');await ws.close()
        self.assertEqual((await self.client.get(self.site.make_url('/_admin/api/session'))).status,403)
    async def test_multi_choice_rejects_foreign_system_and_checks_password(self):
        await self.device('one');await self.device('two');await self.device('wrong',password='different-password')
        status,data=await self.login();self.assertEqual(status,200);self.assertIsNone(data['selected']);self.assertEqual({s['id'] for s in data['systems']},{'one','two'})
        response=await self.client.post(self.site.make_url('/_cloud/select'),json={'id':'wrong'},headers={'Origin':server.ORIGIN,'X-CSRF-Token':data['csrf']});self.assertEqual(response.status,403)
        response=await self.client.post(self.site.make_url('/_cloud/select'),json={'id':'two'},headers={'Origin':server.ORIGIN,'X-CSRF-Token':data['csrf']});self.assertEqual(response.status,200)
        self.assertIn('two',await (await self.client.get(self.site.make_url('/'))).text())
    async def test_bad_password_origin_and_revocation(self):
        await self.device('one');self.assertEqual((await self.login('wrong'))[0],401)
        r=await self.client.post(self.site.make_url('/_cloud/login'),json={'email':'user@example.com','password':'test-password-long'},headers={'Origin':'https://evil.example'});self.assertEqual(r.status,403)
        await self.login()
        r=await self.client.post(self.site.make_url('/_cloud/logout'),json={});self.assertEqual(r.status,403)
        with server.connect() as c:c.execute('UPDATE systems SET revoked=1 WHERE id=?',('one',))
        self.assertEqual((await self.client.get(self.site.make_url('/api/auth/session'))).status,401)
    async def test_rogue_registered_system_cannot_collect_password(self):
        await self.device('rogue',password='attacker-password')
        self.assertEqual((await self.login())[0],401)
        self.assertFalse(self.portal.sessions)

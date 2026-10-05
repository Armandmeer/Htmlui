import unittest, asyncio, tempfile, threading, shutil, json, hashlib, secrets, socket, os, subprocess, ssl, time
from pathlib import Path
from aiohttp import ClientSession, CookieJar, TCPConnector, WSMsgType
from aiohttp.test_utils import TestServer
import server
from gateway import Portal

class NuvexEndToEnd(unittest.IsolatedAsyncioTestCase):
    async def test_real_nuvex_tls_login_http_websocket_revocation(self):
        node=shutil.which('node')
        if not node:self.skipTest('Node is required for the real Nuvex integration test.')
        root=server.ROOT;cert=root/'tests/tls/cert.pem';key=root/'tests/tls/key.pem'
        if not cert.exists():cert=root/'release/tests/tls/cert.pem';key=root/'release/tests/tls/key.pem'
        if not cert.exists():self.skipTest('Generate a temporary test certificate before running this integration test.')
        previous=(server.DB,server.DEV,server.ORIGIN,server.REMOTE_ACCESS)
        source=root/'release/nuvex-ai-0.4.1'
        if not source.exists():source=root.parent
        tmp=tempfile.TemporaryDirectory();appdir=Path(tmp.name)/'app'
        shutil.copytree(source,appdir,ignore=shutil.ignore_patterns('node_modules','cloud-server','.git','users.json','nuvex_cloud_access.json','github_update.json','settings_security.json','smarthome_state*.json','.venv*'))
        server.DB=Path(tmp.name)/'cloud.db';server.DEV=True;server.REMOTE_ACCESS=True;server.init()
        salt=secrets.token_hex(16);password='correct-end-to-end-password';email='user@example.com'
        password_hash=hashlib.scrypt(password.encode(),salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=64*1024*1024).hex()
        (appdir/'users.json').write_text(json.dumps({'users':[{'email':email,'role':'admin','salt':salt,'passwordHash':password_hash}]}))
        token=secrets.token_urlsafe(48)
        with server.connect() as c:c.execute('INSERT INTO systems(id,name,token,first_email,admin_email,accounts,version,seen) VALUES(?,?,?,?,?,?,?,?)',('live','Actual Nuvex',server.digest(token),email,email,json.dumps([{'email':email,'role':'admin','disabled':False}]),'0.4.1',int(time.time())))
        backend=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);thread=threading.Thread(target=backend.serve_forever,daemon=True);thread.start()
        portal=Portal('http://127.0.0.1:'+str(backend.server_port));site=TestServer(portal.app(),scheme='https')
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key);await site.start_server(ssl=tls)
        server.ORIGIN=str(site.make_url('/')).rstrip('/')
        (appdir/'nuvex_cloud_access.json').write_text(json.dumps({'enabled':True,'automatic':True,'id':'live','name':'Actual Nuvex','firstEmail':email,'primaryAdmin':email,'token':token,'url':server.ORIGIN,'ca':cert.read_text()}))
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        env={**os.environ,'HTML_UI_PORT':str(port),'HTML_UI_BIND':'127.0.0.1','NUVEX_DISABLE_MDNS':'1','NODE_PATH':os.environ.get('NUVEX_TEST_NODE_MODULES',str(source/'node_modules'))}
        log=open(Path(tmp.name)/'node.log','w')
        process=subprocess.Popen([node,str(appdir/'server.js')],cwd=appdir,env=env,stdout=log,stderr=subprocess.STDOUT)
        trust=ssl.create_default_context(cafile=str(cert))
        try:
            for _ in range(120):
                if 'live' in portal.devices:break
                if process.poll() is not None:raise AssertionError('Nuvex exited: '+(Path(tmp.name)/'node.log').read_text())
                await asyncio.sleep(.1)
            if 'live' not in portal.devices:
                async with ClientSession() as debug:
                    r=await debug.get('http://127.0.0.1:'+str(port)+'/api/auth/session')
                    details=str(r.status)
                print('Nuvex log:',(Path(tmp.name)/'node.log').read_text())
                print('Runtime cloud state:',json.loads((appdir/'nuvex_cloud_access.json').read_text()).get('id'))
                raise AssertionError('Nuvex did not establish its authenticated outgoing relay; local HTTP '+details)
            async with ClientSession(cookie_jar=CookieJar(unsafe=True),connector=TCPConnector(ssl=trust)) as client:
                r=await client.post(site.make_url('/_cloud/login'),json={'email':email,'password':password},headers={'Origin':server.ORIGIN})
                data=await r.json();self.assertEqual(r.status,200,data);self.assertEqual(data['selected'],'live')
                r=await client.get(site.make_url('/'));html=await r.text();self.assertEqual(r.status,200);self.assertIn('nuvexCloudCard',html)
                r=await client.get(site.make_url('/api/auth/session'));self.assertEqual((await r.json())['user']['email'],email)
                r=await client.get(site.make_url('/users.json'));self.assertEqual(r.status,404)
                ws=await client.ws_connect(site.make_url('/ws'),headers={'Origin':server.ORIGIN})
                message=await ws.receive(timeout=5);self.assertEqual(message.type,WSMsgType.TEXT);self.assertEqual(json.loads(message.data)['type'],'knx-status')
                with server.connect() as c:c.execute('UPDATE systems SET revoked=1 WHERE id=?',('live',))
                self.assertEqual((await client.get(site.make_url('/api/auth/session'))).status,401)
                message=await ws.receive(timeout=8);self.assertIn(message.type,(WSMsgType.CLOSE,WSMsgType.CLOSED))
                await ws.close()
                salt_admin=secrets.token_bytes(32)
                with server.connect() as c:c.execute('INSERT INTO admin VALUES(?,?,?)',('cloud-admin@example.com',salt_admin.hex(),hashlib.pbkdf2_hmac('sha256',b'cloud-admin-test-password',salt_admin,600000).hex()))
                page=await client.get(site.make_url('/admin'));self.assertEqual(page.status,200);self.assertIn('/_admin/app.js',await page.text())
                r=await client.post(site.make_url('/_admin/api/login'),json={'email':'cloud-admin@example.com','password':'cloud-admin-test-password'},headers={'Origin':server.ORIGIN})
                admin=await r.json();self.assertEqual(r.status,200,admin)
                r=await client.post(site.make_url('/_admin/api/delete-system'),json={'id':'live'},headers={'Origin':server.ORIGIN,'X-CSRF-Token':admin['csrf']});self.assertEqual(r.status,200)
        finally:
            process.terminate();process.wait(timeout=10);log.close()
            await site.close();backend.shutdown();backend.server_close();thread.join()
            server.DB,server.DEV,server.ORIGIN,server.REMOTE_ACCESS=previous;tmp.cleanup()

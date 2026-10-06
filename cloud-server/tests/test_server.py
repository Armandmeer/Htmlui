import unittest, tempfile, threading, json, urllib.request, urllib.error, hashlib, secrets, time
from pathlib import Path
import server

class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();server.DB=Path(cls.tmp.name)/'test.db';server.DEV=True;server.init()
        salt=secrets.token_bytes(32)
        with server.connect() as c:
            c.execute('INSERT INTO admin VALUES(?,?,?)',('admin@example.com',salt.hex(),hashlib.pbkdf2_hmac('sha256',b'long-test-password',salt,600000).hex()))
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.base='http://127.0.0.1:'+str(cls.http.server_port);server.ORIGIN=cls.base
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()
    def req(self,path,data=None,headers=None):
        req=urllib.request.Request(self.base+path,json.dumps(data).encode() if data is not None else None,headers or {})
        try:
            with urllib.request.urlopen(req) as r:return r.status,json.load(r),r.headers
        except urllib.error.HTTPError as e:return e.code,json.load(e),e.headers
    def login(self):
        status,result,headers=self.req('/api/login',{'email':'admin@example.com','password':'long-test-password'},{'Origin':self.base})
        self.assertEqual(status,200)
        return {'Cookie':headers['Set-Cookie'].split(';')[0],'Origin':self.base,'X-CSRF-Token':result['csrf']}
    def test_registration_lifecycle(self):
        auth=self.login()
        self.assertEqual(self.req('/api/status',headers=auth)[1]['version'],'0.3.0')
        self.assertEqual(self.req('/api/status')[0],401)
        self.assertEqual(self.req('/api/pairing',{}, {'Cookie':auth['Cookie'],'Origin':self.base})[0],403)
        code=self.req('/api/pairing',{},auth)[1]['code']
        data={'pairingCode':code,'name':'Test Pi','version':'1','firstRegisteredEmail':'owner@example.com','adminEmail':'owner@example.com','accounts':[{'email':'owner@example.com','role':'admin'}]}
        status,registration,_=self.req('/device/register',data);self.assertEqual(status,201)
        self.assertEqual(self.req('/device/register',data)[0],403)
        device={'Authorization':'Bearer '+registration['token']}
        self.assertEqual(self.req('/device/heartbeat',data,device)[0],200)
        data['version']='0.4.1'
        self.assertEqual(self.req('/device/heartbeat',data,device)[0],200)
        self.assertEqual(next(r for r in self.req('/api/systems',headers=auth)[1] if r['id']==registration['id'])['version'],'0.4.1')
        self.assertEqual(self.req('/api/systems')[0],401)
        system=next(r for r in self.req('/api/systems',headers=auth)[1] if r['id']==registration['id']);self.assertTrue(system['online']);self.assertNotIn('token',system)
        data['accounts']=[{'email':'other@example.com','role':'admin'}];data['adminEmail']='other@example.com'
        self.assertEqual(self.req('/device/heartbeat',data,device)[0],200)
        system=next(r for r in self.req('/api/systems',headers=auth)[1] if r['id']==registration['id']);self.assertEqual(system['first_email'],'owner@example.com');self.assertEqual(system['admin_email'],'other@example.com')
        self.assertEqual(self.req('/api/revoke',{'id':registration['id']},auth)[0],200)
        self.assertEqual(self.req('/device/heartbeat',data,device)[0],401)
        self.assertEqual(self.req('/api/logout',{},auth)[0],200)
        self.assertEqual(self.req('/api/systems',headers=auth)[0],401)
    def test_validation_and_expiry(self):
        self.assertEqual(self.req('/api/login',{}, {'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.req('/api/login',{'email':'admin@example.com','password':'wrong'},{'Origin':self.base})[0],401)
        with server.connect() as c:c.execute('INSERT INTO pairing VALUES(?,?)',(server.digest('expired'),int(time.time())-1))
        data={'pairingCode':'expired','name':'Test','firstRegisteredEmail':'a@b.nl','adminEmail':'a@b.nl','accounts':[{'email':'a@b.nl','role':'admin'}]}
        self.assertEqual(self.req('/device/register',data)[0],403)
        data['accounts']=[{'email':'a@b.nl','role':'user'}]
        self.assertEqual(self.req('/device/register',data)[0],400)
        self.assertEqual(self.req('/device/heartbeat',{}, {'Authorization':'Bearer wrong'})[0],401)
    def test_delete_only_revoked_and_old_key_remains_blocked(self):
        auth=self.login();key=secrets.token_urlsafe(48)
        payload={'registrationKey':key,'name':'Delete test','version':'1','firstRegisteredEmail':'delete@example.com','adminEmail':'delete@example.com','accounts':[{'email':'delete@example.com','role':'admin'}]}
        status,data,_=self.req('/device/enroll',payload);self.assertEqual(status,200);sid=data['id']
        self.assertEqual(self.req('/api/delete-system',{'id':sid},auth)[0],409)
        self.assertEqual(self.req('/api/revoke',{'id':sid},auth)[0],200)
        self.assertEqual(self.req('/api/delete-system',{'id':sid})[0],403)
        self.assertEqual(self.req('/api/delete-system',{'id':sid},auth)[0],200)
        self.assertFalse(any(x['id']==sid for x in self.req('/api/systems',headers=auth)[1]))
        self.assertEqual(self.req('/device/enroll',payload)[0],403)
    def test_login_throttling(self):
        with server.connect() as c:c.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',('127.0.0.1',10,int(time.time())+900))
        self.assertEqual(self.req('/api/login',{'email':'admin@example.com','password':'long-test-password'},{'Origin':self.base})[0],429)
        with server.connect() as c:c.execute('DELETE FROM attempts')

    def test_reset_cli_clears_lockout_and_accepts_new_password(self):
        import subprocess,os
        with server.connect() as c:c.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',('127.0.0.1',10,int(time.time())+900))
        code='import sys,runpy,getpass; getpass.getpass=lambda prompt: "new-password-for-reset"; sys.argv=[sys.argv[1],"create-admin"]; runpy.run_path(sys.argv[0],run_name="__main__")'
        result=subprocess.run([__import__('sys').executable,'-c',code,str(server.ROOT/'server.py')],input='reset@example.com\n',text=True,capture_output=True,timeout=15,env={**os.environ,'NUVEX_DB':str(server.DB)})
        self.assertEqual(result.returncode,0,result.stderr)
        status,_,_=self.req('/api/login',{'email':'reset@example.com','password':'new-password-for-reset'},{'Origin':self.base})
        self.assertEqual(status,200)
        with server.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM attempts WHERE count>=10').fetchone()[0],0)

    def test_explicit_local_origin_alias(self):
        previous=server.ALLOWED_ORIGINS
        server.ALLOWED_ORIGINS={'https://localhost:8443','https://127.0.0.1:8443'}
        try:
            data={'email':'admin@example.com','password':'long-test-password'}
            self.assertEqual(self.req('/api/login',data,{'Origin':'https://localhost:8443'})[0],200)
            self.assertEqual(self.req('/api/login',data,{'Origin':'https://evil.example'})[0],403)
            self.assertEqual(self.req('/api/login',data,{'Origin':'https://localhost:9999'})[0],403)
        finally:server.ALLOWED_ORIGINS=previous

    def test_automatic_enrollment_idempotent_and_revocable(self):
        key=secrets.token_urlsafe(48)
        data={'registrationKey':key,'name':'Automatic Pi','version':'3.0.0','firstRegisteredEmail':'owner@example.com','adminEmail':'owner@example.com','accounts':[{'email':'owner@example.com','role':'admin'}]}
        status,result,_=self.req('/device/enroll',data);self.assertEqual(status,200)
        self.assertEqual(self.req('/device/enroll',data)[1]['id'],result['id'])
        auth=self.login()
        rows=self.req('/api/systems',headers=auth)[1]
        row=next(r for r in rows if r['id']==result['id']);self.assertEqual(row['enrollment'],'automatic');self.assertNotIn('token',row)
        self.assertEqual(self.req('/device/heartbeat',data,{'Authorization':'Bearer '+key})[0],200)
        self.assertEqual(self.req('/api/revoke',{'id':result['id']},auth)[0],200)
        self.assertEqual(self.req('/device/enroll',data)[0],403)
        self.assertEqual(self.req('/device/heartbeat',data,{'Authorization':'Bearer '+key})[0],401)

if __name__=='__main__':unittest.main()

"""Nuvex Cloud Access: dependency-free registration service."""
import os, json, sqlite3, secrets, hashlib, hmac, time, argparse
import subprocess, threading, re, atexit
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.cookies import SimpleCookie

ROOT = Path(__file__).parent
DB = Path(os.environ.get('NUVEX_DB', ROOT / 'data/cloud.db'))
ORIGIN = os.environ.get('NUVEX_ORIGIN', 'http://localhost:8080').rstrip('/')
DEV = os.environ.get('NUVEX_DEV') == '1'
STARTED = int(time.time())
REMOTE_ACCESS = False
ALLOWED_ORIGINS = {x.rstrip('/') for x in os.environ.get('NUVEX_ALLOWED_ORIGINS', '').split(',') if x}

class QuickTunnel:
    def __init__(self):
        self.lock = threading.RLock()
        self.process = None
        self.url = ''
        self.error = ''
        self.mode = 'temporary'
        self.connected = False
    def config(self):
        try: return json.loads((DB.parent/'tunnel.json').read_text())
        except (OSError, ValueError): return {}
    def save(self, value):
        file = DB.parent/'tunnel.json'
        tmp = file.with_suffix('.tmp')
        with os.fdopen(os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600), 'w') as f: json.dump(value, f)
        tmp.replace(file)
    def status(self):
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            config = self.config()
            return {'running':running, 'connected':running and self.connected, 'mode':self.mode, 'url':self.url if running else '', 'error':self.error, 'configured':bool(config.get('token')), 'hostname':config.get('hostname','')}
    def allows(self, origin):
        s = self.status()
        return bool(s['url']) and origin == s['url']
    def start(self, mode='temporary'):
        with self.lock:
            if self.status()['running']: return self.status()
            self.url = ''; self.error = ''
            self.mode = mode; self.connected = False
            config = self.config()
            env = dict(os.environ)
            command = ['cloudflared','tunnel','--no-autoupdate']
            if mode == 'fixed':
                if not config.get('token'): raise ValueError('Koppel eerst een vast adres.')
                self.url = 'https://' + config['hostname']
                env['TUNNEL_TOKEN'] = config['token']
                command += ['run']
            else:
                env.pop('TUNNEL_TOKEN', None)
                command += ['--url','http://127.0.0.1:8081']
            try:
                self.process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            except OSError:
                self.error = 'Cloudflared ontbreekt of kan niet starten. Installeer cloudflared op de Pi.'
                return self.status()
            threading.Thread(target=self.read, args=(self.process,), daemon=True).start()
            return self.status()
    def read(self, process):
        try:
            for line in process.stdout:
                if 'Registered tunnel connection' in line:
                    with self.lock:
                        if self.process is process: self.connected = True
                match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com\b', line)
                if match:
                    with self.lock:
                        if self.process is process and self.mode == 'temporary': self.url = match.group(0)
            process.wait()
        finally:
            process.stdout.close()
            with self.lock:
                if self.process is process:
                    self.url = ''
                    self.error = 'Tunnel gestopt. Klik Starten om opnieuw te verbinden.'
    def stop(self):
        with self.lock:
            process = self.process
            self.process = None; self.url = ''; self.error = ''; self.connected = False
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            return self.status()

TUNNEL = QuickTunnel()
atexit.register(TUNNEL.stop)

def digest(value): return hashlib.sha256(value.encode()).hexdigest()
class DatabaseConnection(sqlite3.Connection):
    def __exit__(self,*args):
        try:return super().__exit__(*args)
        finally:self.close()
def connect():
    c = sqlite3.connect(DB, timeout=10, factory=DatabaseConnection)
    c.row_factory = sqlite3.Row
    return c
def init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connect() as c:
        c.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS admin(email TEXT PRIMARY KEY, salt TEXT, password TEXT);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, csrf TEXT, expires INTEGER);
        CREATE TABLE IF NOT EXISTS pairing(code TEXT PRIMARY KEY, expires INTEGER);
        CREATE TABLE IF NOT EXISTS systems(id TEXT PRIMARY KEY, name TEXT, token TEXT, first_email TEXT, admin_email TEXT, accounts TEXT, version TEXT, seen INTEGER, revoked INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER, event TEXT, system_id TEXT);
        CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER, reset INTEGER);
        CREATE TABLE IF NOT EXISTS revoked_keys(token TEXT PRIMARY KEY);
        ''')
        if 'enrollment' not in [r['name'] for r in c.execute('PRAGMA table_info(systems)')]:
            c.execute("ALTER TABLE systems ADD COLUMN enrollment TEXT NOT NULL DEFAULT 'paired'")
def audit(c, event, sid=''):
    c.execute('INSERT INTO audit(at,event,system_id) VALUES(?,?,?)', (int(time.time()), event, sid))
def accounts(data):
    items = data.get('accounts')
    if not isinstance(items, list) or not 1 <= len(items) <= 500: raise ValueError('Geef 1 tot 500 accounts op.')
    result = []
    for item in items:
        email = item.get('email', '').strip().lower()
        role = item.get('role', 'user')
        if len(email) > 254 or '@' not in email or role not in ('admin', 'user'): raise ValueError('Ongeldig account.')
        if email in [x['email'] for x in result]: raise ValueError('Dubbel e-mailadres.')
        disabled = item.get('disabled', False)
        if not isinstance(disabled, bool): raise ValueError('Ongeldige accountstatus.')
        result.append({'email': email, 'role': role, 'disabled': disabled})
    admin = data.get('adminEmail', '').strip().lower()
    if not any(x['email'] == admin and x['role'] == 'admin' and not x['disabled'] for x in result): raise ValueError('Actieve admin moet in de accountlijst staan.')
    return result, admin

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(20)
        super().setup()
    def log_message(self, *args): pass  # Never log credentials or registration bodies.
    def send(self, status, payload, cookie=None, content_type='application/json'):
        body = payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
        self.send_response(status)
        for k,v in {'Content-Type':content_type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}.items(): self.send_header(k,v)
        if not DEV: self.send_header('Strict-Transport-Security', 'max-age=31536000')
        if cookie: self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def session(self, c):
        cookie = SimpleCookie(); cookie.load(self.headers.get('Cookie',''))
        token = cookie['session'].value if 'session' in cookie else ''
        return c.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (digest(token), int(time.time()))).fetchone()
    def do_GET(self):
        with connect() as c:
            if self.path in ('/', '/app.js', '/style.css'):
                name = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[self.path]
                return self.send(200, (ROOT/'web'/name).read_text(encoding='utf-8'), content_type={'/':'text/html; charset=utf-8','/app.js':'text/javascript','/style.css':'text/css'}[self.path])
            if self.path == '/health': return self.send(200, {'status':'ok'})
            s = self.session(c)
            if not s: return self.send(401, {'error':'Log eerst in.'})
            if self.path == '/api/session': return self.send(200, {'csrf':s['csrf']})
            if self.path == '/api/tunnel': return self.send(200, TUNNEL.status())
            if self.path == '/api/status':
                return self.send(200, {'version':'0.4.1' if REMOTE_ACCESS else '0.3.0','uptimeSeconds':int(time.time())-STARTED,'serverTime':int(time.time()),'httpsRequired':not DEV,'remoteAccessEnabled':REMOTE_ACCESS})
            if self.path == '/api/systems':
                rows = []
                for r in c.execute('SELECT id,name,first_email,admin_email,accounts,version,seen,revoked,enrollment FROM systems ORDER BY seen DESC'):
                    d = dict(r); d['accounts'] = json.loads(d['accounts']); d['online'] = not d['revoked'] and time.time()-d['seen'] < 90; rows.append(d)
                return self.send(200, rows)
            if self.path == '/api/audit': return self.send(200, [dict(r) for r in c.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')])
        self.send(404, {'error':'Niet gevonden.'})
    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length','0'))
            if size < 1 or size > 131072: return self.send(413, {'error':'Ongeldige berichtgrootte.'})
            data = json.loads(self.rfile.read(size))
            if not isinstance(data, dict): raise ValueError('JSON-object vereist.')
            with connect() as c:
                now = int(time.time())
                if self.path.startswith('/api/'):
                    if self.headers.get('Origin') not in ({ORIGIN} | ALLOWED_ORIGINS) and not TUNNEL.allows(self.headers.get('Origin')): return self.send(403, {'error':'Ongeldige origin.'})
                if self.path == '/api/login':
                    c.execute('BEGIN IMMEDIATE')
                    key = self.client_address[0]
                    a = c.execute('SELECT * FROM attempts WHERE key=?', (key,)).fetchone()
                    if a and a['reset'] > now and a['count'] >= 10: return self.send(429, {'error':'Probeer over 15 minuten opnieuw.'})
                    count = a['count']+1 if a and a['reset'] > now else 1
                    c.execute('INSERT OR REPLACE INTO attempts VALUES(?,?,?)',(key,count,a['reset'] if a and a['reset'] > now else now+900))
                    r = c.execute('SELECT * FROM admin WHERE email=?',(str(data.get('email','')).lower().strip(),)).fetchone()
                    password = str(data.get('password',''))
                    if len(password)>1024: raise ValueError('Wachtwoord te lang.')
                    hashed = hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(r['salt']) if r else b'0'*32,600000).hex()
                    if not r or not hmac.compare_digest(hashed,r['password']):
                        audit(c,'admin.login_failed')
                        return self.send(401, {'error':'Onjuiste inloggegevens.'})
                    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
                    c.execute('DELETE FROM sessions WHERE expires<?',(now,))
                    c.execute('INSERT INTO sessions VALUES(?,?,?)',(digest(token),csrf,now+28800)); audit(c,'admin.login')
                    return self.send(200, {'csrf':csrf}, 'session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'+('' if DEV else '; Secure'))
                if self.path.startswith('/api/'):
                    s = self.session(c)
                    if not s: return self.send(401, {'error':'Log eerst in.'})
                    if not hmac.compare_digest(self.headers.get('X-CSRF-Token',''),s['csrf']): return self.send(403, {'error':'Ongeldige CSRF-token.'})
                    if self.path == '/api/tunnel/configure':
                        hostname = str(data.get('hostname','')).strip().lower()
                        token = str(data.get('token','')).strip()
                        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', hostname) or '.' not in hostname or '..' in hostname or not re.fullmatch(r'[A-Za-z0-9_+/=-]{40,4096}', token): raise ValueError('Ongeldig adres of tunnel-token.')
                        TUNNEL.stop(); TUNNEL.save({'hostname':hostname, 'token':token, 'enabled':True})
                        audit(c,'tunnel.configured')
                        return self.send(200,TUNNEL.start('fixed'))
                    if self.path == '/api/tunnel/remove':
                        TUNNEL.stop(); TUNNEL.save({}); audit(c,'tunnel.removed')
                        return self.send(200,TUNNEL.status())
                    if self.path in ('/api/tunnel/start','/api/tunnel/stop'):
                        mode = data.get('mode','temporary')
                        if mode not in ('temporary','fixed'): raise ValueError('Ongeldige tunnelmodus.')
                        if self.path.endswith('/start') and TUNNEL.status()['running'] and TUNNEL.mode != mode: TUNNEL.stop()
                        config = TUNNEL.config()
                        if config:
                            config['enabled'] = self.path.endswith('/start') and mode == 'fixed'
                            TUNNEL.save(config)
                        result = TUNNEL.start(mode) if self.path.endswith('/start') else TUNNEL.stop()
                        audit(c, 'tunnel.started' if self.path.endswith('/start') else 'tunnel.stopped')
                        return self.send(200, result)
                    if self.path == '/api/logout':
                        c.execute('DELETE FROM sessions WHERE token=?',(s['token'],))
                        audit(c,'admin.logout')
                        return self.send(200, {}, 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+('' if DEV else '; Secure'))
                    if self.path == '/api/pairing':
                        code = secrets.token_urlsafe(24)
                        c.execute('DELETE FROM pairing WHERE expires<?',(now,))
                        c.execute('INSERT INTO pairing VALUES(?,?)',(digest(code),now+600)); audit(c,'pairing.created')
                        return self.send(201, {'code':code,'expires':now+600})
                    if self.path == '/api/revoke':
                        c.execute('UPDATE systems SET revoked=1 WHERE id=?',(data.get('id'),)); audit(c,'system.revoked',data.get('id',''))
                        return self.send(200, {})
                    if self.path == '/api/delete-system':
                        sid = str(data.get('id',''))
                        c.execute('BEGIN IMMEDIATE')
                        row = c.execute('SELECT token,revoked FROM systems WHERE id=?',(sid,)).fetchone()
                        if not row: return self.send(404,{'error':'Systeem niet gevonden.'})
                        if not row['revoked']: return self.send(409,{'error':'Trek de toegang eerst in.'})
                        c.execute('INSERT OR IGNORE INTO revoked_keys VALUES(?)',(row['token'],))
                        c.execute('DELETE FROM systems WHERE id=?',(sid,));audit(c,'system.deleted',sid)
                        return self.send(200,{})
                if self.path == '/device/enroll':
                    import re
                    key = data.get('registrationKey','')
                    if not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{64}',key): raise ValueError('Ongeldige installatiesleutel.')
                    items, admin = accounts(data)
                    first = str(data.get('firstRegisteredEmail','')).strip().lower()
                    name, version = str(data.get('name','')).strip(), str(data.get('version',''))
                    if not any(x['email']==first for x in items) or not 1 <= len(name) <= 100 or len(version)>100: raise ValueError('Ongeldige registratie.')
                    sid = digest(key)[:36]
                    c.execute('BEGIN IMMEDIATE')
                    if c.execute('SELECT 1 FROM revoked_keys WHERE token=?',(digest(key),)).fetchone():return self.send(403,{'error':'Installatiesleutel ingetrokken.'})
                    existing = c.execute('SELECT * FROM systems WHERE id=?',(sid,)).fetchone()
                    if existing and existing['revoked']: return self.send(403,{'error':'Installatie ingetrokken.'})
                    if not existing:
                        if c.execute('SELECT count(*) FROM systems').fetchone()[0] >= 10000 or c.execute("SELECT count(*) FROM audit WHERE event='system.auto_registered' AND at>?",(now-3600,)).fetchone()[0] >= 100:
                            return self.send(429,{'error':'Registratielimiet bereikt.'})
                        c.execute("INSERT INTO systems(id,name,token,first_email,admin_email,accounts,version,seen,enrollment) VALUES(?,?,?,?,?,?,?,?, 'automatic')",(sid,name,digest(key),first,admin,json.dumps(items),version,now))
                        audit(c,'system.auto_registered',sid)
                    return self.send(200,{'id':sid,'heartbeatSeconds':30,'remoteAccessEnabled':REMOTE_ACCESS})
                if self.path == '/device/register':
                    items, admin = accounts(data)
                    first = str(data.get('firstRegisteredEmail','')).strip().lower()
                    if not any(x['email']==first for x in items): raise ValueError('Eerste geregistreerde account ontbreekt.')
                    name, version = str(data.get('name','')).strip(), str(data.get('version',''))
                    if not 1 <= len(name) <= 100 or len(version)>100: raise ValueError('Ongeldige naam of versie.')
                    c.execute('BEGIN IMMEDIATE')
                    result = c.execute('DELETE FROM pairing WHERE code=? AND expires>?',(digest(str(data.get('pairingCode',''))),now))
                    if result.rowcount != 1: return self.send(403, {'error':'Koppelcode verlopen of gebruikt.'})
                    sid, token = secrets.token_urlsafe(18), secrets.token_urlsafe(48)
                    c.execute('INSERT INTO systems(id,name,token,first_email,admin_email,accounts,version,seen) VALUES(?,?,?,?,?,?,?,?)',(sid,name,digest(token),first,admin,json.dumps(items),version,now)); audit(c,'system.registered',sid)
                    return self.send(201, {'id':sid,'token':token,'heartbeatSeconds':30})
                if self.path in ('/device/heartbeat','/device/disable'):
                    auth = self.headers.get('Authorization','')
                    r = c.execute('SELECT * FROM systems WHERE token=? AND revoked=0',(digest(auth[7:]) if auth.startswith('Bearer ') else '',)).fetchone()
                    if not r: return self.send(401, {'error':'Systeem niet geautoriseerd.'})
                    if self.path.endswith('disable'):
                        c.execute('UPDATE systems SET revoked=1 WHERE id=?',(r['id'],)); audit(c,'system.disabled',r['id'])
                    else:
                        items, admin = accounts(data)
                        version = str(data.get('version',r['version']))
                        if len(version)>100: raise ValueError('Ongeldige versie.')
                        if json.loads(r['accounts']) != items or r['admin_email'] != admin: audit(c,'system.accounts_updated',r['id'])
                        if now-r['seen'] >= 90: audit(c,'system.reconnected',r['id'])
                        c.execute('UPDATE systems SET admin_email=?,accounts=?,version=?,seen=? WHERE id=?',(admin,json.dumps(items),version,now,r['id']))
                    return self.send(200, {'heartbeatSeconds':30,'remoteAccessEnabled':REMOTE_ACCESS})
                return self.send(404, {'error':'Niet gevonden.'})
        except (ValueError, TypeError, AttributeError): self.send(400, {'error':'Ongeldige invoer.'})
        except Exception: self.send(500, {'error':'Interne serverfout.'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('command',choices=['serve','create-admin']); args=parser.parse_args(); init()
    if args.command == 'create-admin':
        import getpass
        email = input('Admin e-mail: ').strip().lower(); password = getpass.getpass('Wachtwoord (minimaal 16 tekens): ')
        if '@' not in email or not 16 <= len(password) <= 1024: raise SystemExit('Ongeldig e-mailadres of wachtwoordlengte (16 tot 1024 tekens).')
        salt = secrets.token_bytes(32)
        with connect() as c:
            c.execute('INSERT OR REPLACE INTO admin VALUES(?,?,?)',(email,salt.hex(),hashlib.pbkdf2_hmac('sha256',password.encode(),salt,600000).hex()))
            c.execute('DELETE FROM sessions')
            c.execute('DELETE FROM attempts')
            audit(c,'admin.credentials_reset')
        print('Admin opgeslagen; bestaande sessies afgesloten en loginblokkade opgeheven.')
    else:
        if not DEV and not ORIGIN.startswith('https://'): raise SystemExit('Stel NUVEX_ORIGIN in op de publieke HTTPS URL, of gebruik NUVEX_DEV=1 lokaal.')
        server = ThreadingHTTPServer(('127.0.0.1',int(os.environ.get('PORT','8080'))), Handler)
        server.socket.settimeout(30)
        if TUNNEL.config().get('enabled'): TUNNEL.start('fixed')
        print('Nuvex Cloud Access luistert op 127.0.0.1:8080'); server.serve_forever()

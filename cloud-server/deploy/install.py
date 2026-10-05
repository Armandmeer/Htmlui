"""Interactive Raspberry Pi OS installer. Run with sudo; no default credentials."""
import argparse, ipaddress, json, os, platform, re, shutil, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit

SOURCE=Path(__file__).resolve().parents[1]
DEST=Path('/opt/nuvex-cloud')
STATE=Path('/var/lib/nuvex-cloud')

def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)

def write(path, contents, mode=0o644):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(contents,encoding='utf-8');path.chmod(mode)

def main():
    p=argparse.ArgumentParser(description='Installeert Nuvex Cloud Access, HTTPS en automatisch starten.')
    p.add_argument('--ip',help='Vast IPv4-adres van deze Pi (standaard automatisch gevonden)')
    p.add_argument('--public-url',help='Optionele publieke HTTPS-origin, bijvoorbeeld https://cloud.example.com')
    p.add_argument('--admin-config',help='Voor automatische SD-installatie: JSON met vooraf gehasht adminwachtwoord')
    a=p.parse_args()
    if platform.system()!='Linux' or not hasattr(os,'geteuid') or os.geteuid()!=0:
        p.error('Voer dit op Raspberry Pi OS uit met sudo bash install.sh.')
    if not shutil.which('apt-get') or not shutil.which('systemctl'):p.error('Raspberry Pi OS met apt en systemd vereist.')
    if not a.ip:
        route=json.loads(subprocess.check_output(['ip','-j','route','get','1.1.1.1']))
        a.ip=route[0].get('prefsrc')
    try:
        address=ipaddress.IPv4Address(a.ip)
        if address.is_loopback or address.is_unspecified:raise ValueError()
    except (ValueError,TypeError):p.error('Geen bruikbaar IPv4-adres; geef --ip 192.168.x.x op.')
    hostname=platform.node().split('.')[0]
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,62}',hostname):p.error('Ongeldige hostnaam.')
    local=f'https://{address}:8443'
    origins=[local,f'https://{hostname}.local:8443','https://localhost:8443','https://127.0.0.1:8443']
    if a.public_url:
        u=urlsplit(a.public_url)
        if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or not re.fullmatch(r'https://[A-Za-z0-9.:-]+/?',a.public_url):p.error('Gebruik een HTTPS-origin zonder pad, login of query.')
        origins.append(a.public_url.rstrip('/'))
    print('Nuvex Cloud Access installeren. Browseradres:',local,flush=True)
    run('apt-get','update')
    run('apt-get','install','-y','python3','python3-aiohttp','nginx','openssl','ca-certificates')
    if subprocess.run(['id','nuvex-cloud'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        run('useradd','--system','--home',str(STATE),'--shell','/usr/sbin/nologin','nuvex-cloud')
    run('install','-d','-o','nuvex-cloud','-g','nuvex-cloud','-m','700',str(STATE))
    # Stop writes while replacing application files; never copy secrets or a developer DB.
    subprocess.run(['systemctl','stop','nuvex-cloud'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for name in ('server.py','gateway.py','client.py','accounts.example.json','README.md','START-HIER.md'):
        DEST.mkdir(parents=True,exist_ok=True)
        if (SOURCE/name).resolve()!=(DEST/name).resolve():shutil.copyfile(SOURCE/name,DEST/name)
        (DEST/name).chmod(0o644)
    for folder in ('web','docs'):
        for file in (SOURCE/folder).rglob('*'):
            if file.is_file():
                target=DEST/file.relative_to(SOURCE);target.parent.mkdir(parents=True,exist_ok=True)
                if file.resolve()!=target.resolve():shutil.copyfile(file,target)
                target.chmod(0o644)
    write('/etc/nuvex-cloud.env','NUVEX_ORIGIN='+local+'\nNUVEX_ALLOWED_ORIGINS='+','.join(origins)+'\n',0o600)
    write('/etc/systemd/system/nuvex-cloud.service',(SOURCE/'deploy/nuvex-cloud.service').read_text())
    cert=Path('/etc/nuvex-cloud/tls');cert.mkdir(parents=True,exist_ok=True);cert.chmod(0o700)
    if not (cert/'server.key').exists():
        run('openssl','req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','365','-keyout',str(cert/'server.key'),'-out',str(cert/'server.crt'),'-subj',f'/CN={hostname}.local','-addext',f'subjectAltName=DNS:{hostname}.local,IP:{address}')
        (cert/'server.key').chmod(0o600)
    common='''client_max_body_size 8m;
client_body_timeout 20s;
client_header_timeout 20s;
limit_req_status 429;
location = /api/login {
    limit_req zone=nuvex_login burst=5 nodelay;
    include /etc/nginx/snippets/nuvex-proxy.conf;
}
location = /device/enroll {
    limit_req zone=nuvex_login burst=5 nodelay;
    include /etc/nginx/snippets/nuvex-proxy.conf;
}
location / {
    limit_req zone=nuvex_requests burst=60 nodelay;
    include /etc/nginx/snippets/nuvex-proxy.conf;
}
'''
    write('/etc/nginx/snippets/nuvex-proxy.conf','''proxy_pass http://127.0.0.1:8080;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $nuvex_connection;
proxy_connect_timeout 5s;
proxy_read_timeout 90s;
proxy_send_timeout 30s;
''')
    conf='''map $http_upgrade $nuvex_connection { default upgrade; '' close; }
limit_req_zone $binary_remote_addr zone=nuvex_login:10m rate=6r/m;
limit_req_zone $binary_remote_addr zone=nuvex_requests:10m rate=20r/s;
server {
    listen 8443 ssl;
    server_name _;
    ssl_certificate /etc/nuvex-cloud/tls/server.crt;
    ssl_certificate_key /etc/nuvex-cloud/tls/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
'''+common+'''}
server {
    listen 127.0.0.1:8081;
    server_name _;
'''+common+'}\n'
    nginx_file=Path('/etc/nginx/conf.d/nuvex-cloud.conf')
    previous=nginx_file.read_text() if nginx_file.exists() else None
    write(nginx_file,conf)
    try:run('nginx','-t')
    except subprocess.CalledProcessError:
        if previous is None:nginx_file.unlink()
        else:write(nginx_file,previous)
        raise SystemExit('Nginx-configuratie ongeldig; eerdere configuratie hersteld. Controleer poort 8443 en 8081.')
    # Create a personal admin interactively only on a fresh install.
    import sqlite3
    has_admin=False
    if (STATE/'cloud.db').exists():
        with sqlite3.connect(STATE/'cloud.db') as c:
            try:has_admin=bool(c.execute('SELECT 1 FROM admin LIMIT 1').fetchone())
            except sqlite3.OperationalError:pass
    if not has_admin:
        if a.admin_config:
            config=json.loads(Path(a.admin_config).read_text())
            email=config['email'];salt=config['salt'];hashed=config['passwordHash']
            if not isinstance(email,str) or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) or not re.fullmatch(r'[a-f0-9]{64}',salt) or not re.fullmatch(r'[a-f0-9]{64}',hashed):raise SystemExit('Ongeldige voorbereide adminconfiguratie.')
            # Schema creation under the service account preserves private file ownership.
            run('runuser','-u','nuvex-cloud','--','env','NUVEX_DB='+str(STATE/'cloud.db'),'python3','-c','import sys; sys.path.insert(0,"/opt/nuvex-cloud"); import server; server.init()')
            with sqlite3.connect(STATE/'cloud.db') as c:c.execute('INSERT INTO admin VALUES(?,?,?)',(email,salt,hashed))
        else:run('runuser','-u','nuvex-cloud','--','env','NUVEX_DB='+str(STATE/'cloud.db'),'python3',str(DEST/'server.py'),'create-admin')
    run('systemctl','daemon-reload');run('systemctl','enable','--now','nuvex-cloud');run('systemctl','enable','nginx');run('systemctl','restart','nginx')
    run('systemctl','is-active','nuvex-cloud','nginx')
    write('/etc/nuvex-cloud/browser-url.txt',local+'\n')
    print('\nInstallatie klaar. Open '+local+' in je browser en log in met je eigen adminaccount.')
    print('Lokaal certificaat: vergelijk de SHA256-vingerafdruk voordat je het vertrouwt:')
    run('openssl','x509','-in',str(cert/'server.crt'),'-noout','-fingerprint','-sha256')
    print('Internettoegang zonder forwarding: tunnel naar http://127.0.0.1:8081; zie START-HIER.md.')

if __name__=='__main__':main()

"""Reference integration; Nuvex supplies accounts from its own user database."""
import argparse, json, os, time, tempfile, urllib.request, urllib.error, uuid
from pathlib import Path

def nuvex_payload(directory, name, first_email=None, preferred_admin=None):
    directory=Path(directory)
    users=json.loads((directory/'users.json').read_text(encoding='utf-8-sig'))['users']
    if not users: raise ValueError('Nuvex heeft nog geen geregistreerde accounts.')
    # Bootstrap writes the first account with createdAt; subsequent users may lack it.
    if not first_email:
        first=users[0]
        if not first.get('createdAt'): raise ValueError('Oorspronkelijk registratieadres onbekend; geef --first-email op.')
        first_email=first['email']
    active=[u for u in users if u.get('role')=='admin' and not u.get('disabled',False)]
    if not active: raise ValueError('Geen actieve Nuvex-admin beschikbaar.')
    admin=next((u for u in active if u['email'].lower()==str(preferred_admin or first_email).lower()),active[0])
    version=json.loads((directory/'package.json').read_text(encoding='utf-8-sig')).get('version','3.0.0')
    mac=':'.join(f'{uuid.getnode():012X}'[i:i+2] for i in range(0,12,2))
    return {'name':name,'macAddress':mac,'version':version,'firstRegisteredEmail':first_email.lower().strip(), 'adminEmail':admin['email'].lower().strip(),
            'accounts':[{'email':u['email'],'role':u.get('role','user'),'disabled':u.get('disabled',False)} for u in users]}

def request(base, route, data, token=None):
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(base+route,json.dumps(data).encode(),headers,method='POST')
    with urllib.request.urlopen(req,timeout=20) as response: return json.load(response)

def save(path, data):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f: json.dump(data,f); f.flush(); os.fsync(f.fileno())
        os.chmod(tmp,0o600); os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['enable','run','disable']);p.add_argument('--url',required=True);p.add_argument('--accounts',default='accounts.json');p.add_argument('--state',default='client-state.json');p.add_argument('--dev',action='store_true');p.add_argument('--nuvex-dir');p.add_argument('--name',default='Nuvex AI 3.0');p.add_argument('--first-email');p.add_argument('--admin-email');a=p.parse_args()
    base=a.url.rstrip('/')
    if not base.startswith('https://') and not (a.dev and base in ('http://localhost:8080','http://127.0.0.1:8080')): p.error('HTTPS is verplicht; --dev staat alleen lokale HTTP toe.')
    path=Path(a.state)
    if a.command=='enable':
        if path.exists(): raise SystemExit('Al gekoppeld. Schakel eerst cloudtoegang uit.')
        import getpass
        data=nuvex_payload(a.nuvex_dir,a.name,a.first_email,a.admin_email) if a.nuvex_dir else json.loads(Path(a.accounts).read_text());data['pairingCode']=getpass.getpass('Eenmalige koppelcode: ')
        save(path,{**request(base,'/device/register',data),'url':base,'firstRegisteredEmail':data['firstRegisteredEmail']});print('Cloud Access geactiveerd.')
    else:
        state=json.loads(path.read_text())
        if state['url']!=base: raise SystemExit('URL verschilt van de gekoppelde server.')
        if a.command=='disable':
            request(base,'/device/disable',{},state['token']);path.unlink();print('Cloud Access gedeactiveerd.')
        else:
            delay=30
            while True:
                try:
                    data=nuvex_payload(a.nuvex_dir,a.name,state.get('firstRegisteredEmail'),a.admin_email) if a.nuvex_dir else json.loads(Path(a.accounts).read_text())
                    request(base,'/device/heartbeat',data,state['token']);delay=30
                except urllib.error.HTTPError as e:
                    if e.code in (401,403): raise SystemExit('Toegang ingetrokken. Opnieuw koppelen vereist.')
                    delay=min(delay*2,300);print('Cloudserver tijdelijk niet beschikbaar.')
                except (OSError,ValueError): delay=min(delay*2,300);print('Verbinding of accountbestand niet beschikbaar.')
                time.sleep(delay)

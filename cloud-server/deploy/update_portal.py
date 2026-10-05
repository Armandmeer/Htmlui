"""Update an existing Pi installation without resetting its DB, accounts or origins."""
import os, shutil, subprocess, datetime
from pathlib import Path

ROOT=Path(__file__).parents[1]
DEST=Path('/opt/nuvex-cloud')
def run(*args):subprocess.run(args,check=True)
def main():
    if not hasattr(os,'geteuid') or os.geteuid()!=0:raise SystemExit('Gebruik sudo python3 deploy/update_portal.py op de Pi.')
    service=Path('/etc/systemd/system/nuvex-cloud.service')
    snippet=Path('/etc/nginx/snippets/nuvex-proxy.conf')
    conf=Path('/etc/nginx/conf.d/nuvex-cloud.conf')
    if not all(p.exists() for p in (DEST,service,snippet,conf)):raise SystemExit('Bestaande Nuvex Cloud Access-installatie niet gevonden.')
    run('apt-get','update');run('apt-get','install','-y','python3-aiohttp')
    backup=Path('/var/backups')/('nuvex-cloud-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    shutil.copytree(DEST,backup/'app')
    previous={p:p.read_text() for p in (service,snippet,conf)}
    for p,text in previous.items():(backup/p.name).write_text(text)
    run('systemctl','stop','nuvex-cloud')
    try:
        for name in ('server.py','gateway.py'):
            shutil.copyfile(ROOT/name,DEST/name)
        for p in (ROOT/'web').iterdir():
            if p.is_file():shutil.copyfile(p,DEST/'web'/p.name)
        service.write_text(previous[service].replace('/opt/nuvex-cloud/server.py serve','/opt/nuvex-cloud/gateway.py'))
        text=previous[snippet].replace('proxy_set_header Connection "";', 'proxy_set_header Upgrade $http_upgrade;\nproxy_set_header Connection $nuvex_connection;')
        text=text.replace('proxy_read_timeout 30s;','proxy_read_timeout 90s;')
        snippet.write_text(text)
        text=previous[conf].replace('client_max_body_size 128k;','client_max_body_size 8m;')
        if '$nuvex_connection' not in text:text="map $http_upgrade $nuvex_connection { default upgrade; '' close; }\n"+text
        conf.write_text(text)
        run('nginx','-t');run('systemctl','daemon-reload');run('systemctl','restart','nginx');run('systemctl','start','nuvex-cloud')
    except Exception:
        for p,text in previous.items():p.write_text(text)
        shutil.copytree(backup/'app',DEST,dirs_exist_ok=True)
        subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','nginx']);subprocess.run(['systemctl','start','nuvex-cloud'])
        raise
    print('Portaal bijgewerkt. Backup:',backup)
    print('Gebruikers: https://<pi-adres>:8443/ | Beheer: https://<pi-adres>:8443/admin')
if __name__=='__main__':main()

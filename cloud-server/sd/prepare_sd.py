"""Prepare an existing Raspberry Pi OS boot partition; never format a disk."""
import argparse, getpass, hashlib, ipaddress, json, os, re, secrets, shutil
from pathlib import Path
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
BOOT_FLAGS=['systemd.run=/boot/firmware/nuvex-firstboot.sh','systemd.run_success_action=reboot','systemd.run_failure_action=reboot','systemd.unit=kernel-command-line.target']

def prepare(boot, email, password, ip='', public_url=''):
    boot=Path(boot).resolve()
    cmd=boot/'cmdline.txt'
    if not cmd.is_file() or not (boot/'config.txt').is_file():raise ValueError('Kies de bootfs-partitie van een bestaande Raspberry Pi OS-kaart: cmdline.txt en config.txt ontbreken.')
    original=cmd.read_text(encoding='utf-8-sig').strip()
    if '\n' in original or not re.search(r'\broot=',original):raise ValueError('Ongeldige Raspberry Pi kernel-commandline; niets gewijzigd.')
    if re.search(r'^\s*cmdline\s*=',(boot/'config.txt').read_text(),re.M):raise ValueError('Deze kaart gebruikt een afwijkend cmdline-bestand; niet ondersteund.')
    if any(t.startswith(('systemd.run=','systemd.unit=','systemd.run_success_action=','systemd.run_failure_action=','init=')) for t in original.split()):
        raise ValueError('Er staat nog een eerste-opstarttaak van Raspberry Pi OS/Imager op de kaart. Laat de Pi eerst eenmaal normaal opstarten, schakel hem netjes uit en probeer daarna opnieuw. De bestaande taak is niet gewijzigd.')
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) or len(password)<16 or len(password)>1024:raise ValueError('Gebruik een geldig e-mailadres en een wachtwoord van 16 tot 1024 tekens.')
    if ip:ipaddress.IPv4Address(ip)
    if public_url:
        u=urlsplit(public_url)
        if u.scheme!='https' or not u.hostname or u.username or u.password or u.path not in ('','/') or u.query or u.fragment or not re.fullmatch(r'https://[A-Za-z0-9.:-]+/?',public_url):raise ValueError('Ongeldige publieke HTTPS-origin.')
    archive=HERE/'nuvex-cloud-pi.tar.gz';script=HERE/'nuvex-firstboot.sh'
    if not archive.is_file() or not script.is_file():raise ValueError('Pak het volledige SD-pakket uit; installatiebestanden ontbreken.')
    if (boot/'cmdline.nuvex-backup.txt').exists():raise ValueError('Er bestaat al een Nuvex-opstartback-up. Controleer de eerdere installatie voordat je opnieuw voorbereidt.')
    salt=secrets.token_bytes(32)
    config={'email':email.lower().strip(),'salt':salt.hex(),'passwordHash':hashlib.pbkdf2_hmac('sha256',password.encode(),salt,600000).hex(),'ip':ip,'publicUrl':public_url.rstrip('/')}
    shutil.copyfile(archive,boot/archive.name)
    # FAT has no Unix executable permissions; the boot command invokes bash explicitly.
    (boot/script.name).write_text(script.read_text(),encoding='utf-8',newline='\n')
    (boot/'nuvex-install.json').write_text(json.dumps(config),encoding='utf-8')
    (boot/'cmdline.nuvex-backup.txt').write_text(original+'\n',encoding='utf-8')
    # Quoted kernel parameter preserves ExecStart's command and argument as one value.
    line=original+' systemd.run="/bin/bash /boot/firmware/nuvex-firstboot.sh" '+' '.join(BOOT_FLAGS[1:])+'\n'
    tmp=boot/'cmdline.nuvex-tmp';tmp.write_text(line,encoding='utf-8');os.replace(tmp,cmd)

if __name__=='__main__':
    p=argparse.ArgumentParser(description='Zet de automatische Nuvex-installer op een bestaande Raspberry Pi OS SD-kaart. Formatteert niets.')
    p.add_argument('--boot',help='Bootfs-stationsletter, bijvoorbeeld E:\\');a=p.parse_args()
    print('Gebruik een Raspberry Pi OS-kaart die al eenmaal normaal is opgestart. Sluit de Pi af voordat je de kaart uitneemt.')
    boot=a.boot or input('Bootfs-station (bijvoorbeeld E:\\): ').strip()
    email=input('Admin e-mailadres: ').strip().lower();password=getpass.getpass('Adminwachtwoord (minimaal 16 tekens): ')
    if password!=getpass.getpass('Herhaal wachtwoord: '):raise SystemExit('Wachtwoorden verschillen; niets gewijzigd.')
    ip=input('Vast Pi IPv4-adres (Enter = automatisch): ').strip()
    public=input('Publieke HTTPS-url (Enter = alleen lokaal): ').strip()
    try:prepare(boot,email,password,ip,public)
    except (ValueError,OSError) as e:raise SystemExit(str(e))
    print('Klaar. Werp de kaart veilig uit en start de Pi met ethernet en internet. Installatie kan enkele minuten duren.')
    print('Na installatie staat het browseradres in nuvex-status.txt op de bootfs-partitie. Geen leesbaar wachtwoord op de kaart opgeslagen.')

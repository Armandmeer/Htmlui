"""Create distributable Pi archives without credentials, databases or developer files."""
import hashlib, tarfile, zipfile
from pathlib import Path

ROOT=Path(__file__).parent
OUTPUT=ROOT/'dist'
def build():
    OUTPUT.mkdir(exist_ok=True)
    files=[ROOT/n for n in ('server.py','gateway.py','client.py','accounts.example.json','README.md','START-HIER.md','install.sh')]
    for folder in ('web','deploy','docs','tests','sd'):
        files.extend(f for f in (ROOT/folder).rglob('*') if f.is_file() and '__pycache__' not in f.parts)
    files=sorted(files)
    with tarfile.open(OUTPUT/'nuvex-cloud-pi.tar.gz','w:gz') as archive:
        for f in files:
            entry=archive.gettarinfo(str(f),'nuvex-cloud-pi/'+f.relative_to(ROOT).as_posix())
            entry.uid=entry.gid=0;entry.uname=entry.gname='root';entry.mode=0o755 if f.name=='install.sh' else 0o644
            with f.open('rb') as data:archive.addfile(entry,data)
    with zipfile.ZipFile(OUTPUT/'nuvex-cloud-pi.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for f in files:archive.write(f,'nuvex-cloud-pi/'+f.relative_to(ROOT).as_posix())
    for path in OUTPUT.glob('nuvex-cloud-pi.*'):
        if path.suffix in ('.zip','.gz'):
            (OUTPUT/(path.name+'.sha256')).write_text(hashlib.sha256(path.read_bytes()).hexdigest()+'  '+path.name+'\n')
    with zipfile.ZipFile(OUTPUT/'nuvex-cloud-sd-autostart.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for name in ('prepare_sd.py','SD-KAART-VOORBEREIDEN.cmd','nuvex-firstboot.sh','SD-START.md'):
            archive.write(ROOT/'sd'/name,name)
        archive.write(OUTPUT/'nuvex-cloud-pi.tar.gz','nuvex-cloud-pi.tar.gz')
    sd=OUTPUT/'nuvex-cloud-sd-autostart.zip'
    (OUTPUT/(sd.name+'.sha256')).write_text(hashlib.sha256(sd.read_bytes()).hexdigest()+'  '+sd.name+'\n')
    print('Pi-installatiepakket gemaakt in',OUTPUT)
if __name__=='__main__':build()

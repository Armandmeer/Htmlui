#!/bin/bash
set -Eeuo pipefail
BOOT=/boot/firmware
if [ ! -f "$BOOT/nuvex-install.json" ]; then BOOT=/boot; fi
exec >>"$BOOT/nuvex-install.log" 2>&1
echo "Nuvex automatische installatie gestart $(date -Is)"
echo "Installatie bezig. Zie nuvex-install.log." > "$BOOT/nuvex-status.txt"
# Remove only our own boot task. A failed attempt returns to normal OS on reboot.
python3 - "$BOOT/cmdline.txt" <<'PY'
import pathlib,sys,shlex
p=pathlib.Path(sys.argv[1]);tokens=shlex.split(p.read_text())
remove={'systemd.run=/bin/bash /boot/firmware/nuvex-firstboot.sh','systemd.run_success_action=reboot','systemd.run_failure_action=reboot','systemd.unit=kernel-command-line.target'}
p.write_text(' '.join(t for t in tokens if t not in remove)+'\n')
PY
trap 'echo "Installatie mislukt. Normale OS-start volgt; zie nuvex-install.log. Herstel via SSH met de instructies in SD-START.md." > "$BOOT/nuvex-status.txt"' ERR
systemctl start NetworkManager.service
systemctl start systemd-timesyncd.service || true
# Fresh boot may still be acquiring DHCP; the destination is only used for route lookup.
for attempt in $(seq 1 120); do
    if ip -4 route get 1.1.1.1 >/dev/null 2>&1 && getent hosts deb.debian.org >/dev/null; then break; fi
    sleep 2
done
mkdir -p /var/tmp/nuvex-provision
tar -xzf "$BOOT/nuvex-cloud-pi.tar.gz" -C /var/tmp/nuvex-provision
export DEBIAN_FRONTEND=noninteractive
python3 - "$BOOT" <<'PY'
import json,pathlib,subprocess,sys
boot=pathlib.Path(sys.argv[1]);cfg=json.loads((boot/'nuvex-install.json').read_text())
args=['python3','/var/tmp/nuvex-provision/nuvex-cloud-pi/deploy/install.py','--admin-config',str(boot/'nuvex-install.json')]
if cfg.get('ip'):args.extend(['--ip',cfg['ip']])
if cfg.get('publicUrl'):args.extend(['--public-url',cfg['publicUrl']])
subprocess.run(args,check=True)
(boot/'nuvex-status.txt').write_text('Installatie geslaagd. Open in je browser: '+pathlib.Path('/etc/nuvex-cloud/browser-url.txt').read_text().strip()+'\nLog in met het adminaccount dat je op je computer hebt gekozen.\n')
# Delete provisioned password hash after success. The original boot backup has no credentials.
(boot/'nuvex-install.json').unlink()
PY
echo "Nuvex installatie geslaagd $(date -Is); opnieuw opstarten."

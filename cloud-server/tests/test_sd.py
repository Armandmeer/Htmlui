import unittest,tempfile,sys,json,shlex,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'sd'))
import prepare_sd

class SDPreparation(unittest.TestCase):
    def test_prepares_boot_without_plain_password(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);boot=root/'bootfs';boot.mkdir();package=root/'package';package.mkdir()
            (package/'nuvex-cloud-pi.tar.gz').write_bytes(b'archive')
            (package/'nuvex-firstboot.sh').write_text('#!/bin/bash\necho test\n')
            (boot/'cmdline.txt').write_text('console=tty1 root=PARTUUID=abc rootwait\n')
            (boot/'config.txt').write_text('[all]\n')
            previous=prepare_sd.HERE;prepare_sd.HERE=package
            try:prepare_sd.prepare(boot,'admin@example.com','a-very-long-password')
            finally:prepare_sd.HERE=previous
            line=(boot/'cmdline.txt').read_text();self.assertEqual(line.count('\n'),1)
            tokens=shlex.split(line);self.assertIn('systemd.run=/bin/bash /boot/firmware/nuvex-firstboot.sh',tokens)
            self.assertIn('root=PARTUUID=abc',tokens)
            cfg=json.loads((boot/'nuvex-install.json').read_text());self.assertNotIn('a-very-long-password',json.dumps(cfg))
            self.assertEqual(cfg['passwordHash'],hashlib.pbkdf2_hmac('sha256',b'a-very-long-password',bytes.fromhex(cfg['salt']),600000).hex())
            self.assertEqual((boot/'cmdline.nuvex-backup.txt').read_text(),'console=tty1 root=PARTUUID=abc rootwait\n')
    def test_existing_imager_task_left_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            boot=Path(d);original='root=PARTUUID=abc systemd.run=/boot/firstrun.sh\n'
            (boot/'cmdline.txt').write_text(original);(boot/'config.txt').write_text('')
            with self.assertRaises(ValueError):prepare_sd.prepare(boot,'admin@example.com','a-very-long-password')
            self.assertEqual((boot/'cmdline.txt').read_text(),original)
            self.assertFalse((boot/'nuvex-install.json').exists())
    def test_wrong_partition_refused(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):prepare_sd.prepare(d,'admin@example.com','a-very-long-password')

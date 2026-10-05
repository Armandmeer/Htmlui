import unittest, tempfile, io, threading
from pathlib import Path
from unittest.mock import patch, Mock
import server

class TunnelTests(unittest.TestCase):
    def test_temporary_origin_and_stop(self):
        t=server.QuickTunnel(); p=Mock(); p.poll.return_value=None
        t.process=p; t.url='https://test.trycloudflare.com'
        self.assertTrue(t.allows(t.url));self.assertFalse(t.allows('https://evil.example'))
        t.stop();self.assertFalse(t.allows('https://test.trycloudflare.com'));p.terminate.assert_called_once()
    def test_fixed_secret_and_command(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server,'DB',Path(folder)/'cloud.db'):
            t=server.QuickTunnel();token='a'*64;t.save({'token':token,'hostname':'cloud.example.com'})
            p=Mock();p.poll.return_value=None
            with patch.object(server.subprocess,'Popen',return_value=p) as launch, patch.object(threading.Thread,'start'):
                result=t.start('fixed')
            self.assertNotIn(token,str(result));self.assertNotIn(token,str(launch.call_args.args))
            self.assertEqual(launch.call_args.kwargs['env']['TUNNEL_TOKEN'],token)
            self.assertEqual(result['url'],'https://cloud.example.com')
            t.stop();t.save({});self.assertFalse(t.status()['configured'])
    def test_reader_rejects_old_process(self):
        t=server.QuickTunnel();p=Mock();p.stdout=io.StringIO('https://old.trycloudflare.com\n');t.read(p)
        self.assertEqual(t.url,'')
    def test_missing_binary(self):
        t=server.QuickTunnel()
        with patch.object(server.subprocess,'Popen',side_effect=FileNotFoundError):result=t.start()
        self.assertFalse(result['running']);self.assertTrue(result['error'])

import unittest,tempfile,json
from pathlib import Path
from client import nuvex_payload

class NuvexAdapter(unittest.TestCase):
    def test_only_public_fields_and_historical_owner(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            (p/'package.json').write_text(json.dumps({'version':'3.0.0'}))
            (p/'users.json').write_text(json.dumps({'users':[{'email':'owner@example.com','role':'admin','createdAt':'2026-10-01','salt':'SECRET','passwordHash':'SECRET'},{'email':'other@example.com','role':'user','disabled':True}]}))
            payload=nuvex_payload(d,'Test')
            self.assertEqual(payload['firstRegisteredEmail'],'owner@example.com')
            self.assertNotIn('SECRET',json.dumps(payload));self.assertTrue(payload['accounts'][1]['disabled'])
            (p/'users.json').write_text(json.dumps({'users':[{'email':'new@example.com','role':'admin'}]}))
            self.assertEqual(nuvex_payload(d,'Test','owner@example.com')['firstRegisteredEmail'],'owner@example.com')
            self.assertEqual(nuvex_payload(d,'Test','owner@example.com')['adminEmail'],'new@example.com')
            with self.assertRaises(ValueError):nuvex_payload(d,'Test')

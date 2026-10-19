import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

spec = importlib.util.spec_from_file_location('init_data', Path(__file__).resolve().parents[1]/'scripts/init_data.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class DownloadChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.content = b'checked data'
        self.asset = {'name':'sample.dat','url':'https://example.invalid/sample.dat',
                      'size':len(self.content),'sha256':hashlib.sha256(self.content).hexdigest()}

    def test_atomic_download_and_cached_no_network(self):
        with patch.object(helper, 'urlopen', return_value=io.BytesIO(self.content)) as fetch:
            result = helper.download(self.asset, self.root)
            self.assertEqual(result.read_bytes(), self.content)
            helper.download(self.asset, self.root)
            self.assertEqual(fetch.call_count, 1)
        self.assertFalse(list(self.root.glob('*.partial')))

    def test_corrupt_download_preserves_existing_file(self):
        old = self.root/'sample.dat';old.write_bytes(b'existing data')
        with patch.object(helper, 'urlopen', return_value=io.BytesIO(b'wrong bytes')):
            with self.assertRaises(ValueError):helper.download(self.asset, self.root, replace=True)
        self.assertEqual(old.read_bytes(), b'existing data')
        self.assertFalse(list(self.root.glob('*.partial')))

    def test_network_failure_does_not_publish_partial_file(self):
        with patch.object(helper, 'urlopen', side_effect=URLError('offline')):
            with self.assertRaises(URLError):helper.download(self.asset, self.root)
        self.assertFalse((self.root/'sample.dat').exists())
        self.assertFalse(list(self.root.glob('*.partial')))

    def test_mismatch_requires_explicit_replace(self):
        (self.root/'sample.dat').write_bytes(b'old')
        with patch.object(helper, 'urlopen') as fetch:
            with self.assertRaises(ValueError):helper.download(self.asset, self.root)
            fetch.assert_not_called()

    def test_path_escape_rejected(self):
        with self.assertRaises(ValueError):helper.download({**self.asset,'name':'../escape'}, self.root)

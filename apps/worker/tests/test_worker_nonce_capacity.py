# +-------------------------------------------------------------------------
#   地理智能平台 - nonce 容量与有效期回归测试
#   文件: test_worker_nonce_capacity.py
#   日期: 2026年09月08日
#   AI 协助: OpenAI ChatGPT (GPT-6 Astra Pro)
# --------------------------------------------------------------------------

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps/worker/src"))
from worker_app.worker_auth import WorkerAuthConfig, WorkerAuthVerifier

SECRET = "nonce-capacity-regression-test-only"
BODY = b'{"args":{}}'
TOOL = "meteorological_inspect"
NOW = 2_000_000_000


def sign(nonce: str, expires: int) -> str:
    payload = {"v": 1, "toolName": TOOL, "iat": NOW, "exp": expires,
               "nonce": nonce, "bodyHash": hashlib.sha256(BODY).hexdigest()}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=")
    signature = hmac.new(SECRET.encode(), encoded, hashlib.sha256).digest()
    return "GeoAgentPlatform-Worker " + encoded.decode() + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


class NonceCapacityRegressionTests(unittest.TestCase):
    def test_full_store_never_forgets_unexpired_nonces(self) -> None:
        for persistent in (False, True):
            with self.subTest(persistent=persistent), tempfile.TemporaryDirectory() as directory:
                config = WorkerAuthConfig(shared_secret=SECRET, nonce_cache_max=2,
                    nonce_store_path=Path(directory) / "nonces.db" if persistent else None)
                verifier = WorkerAuthVerifier(config)
                # SQLite callers must see the same capacity and replay decisions.
                other = WorkerAuthVerifier(config) if persistent else verifier
                a, b, c = (sign(f"capacity-nonce-{letter}-0001", NOW + expiry)
                           for letter, expiry in (("a", 10), ("b", 20), ("c", 30)))
                with patch("worker_app.worker_auth.time.time", return_value=NOW):
                    self.assertIsNone(verifier.verify(a, TOOL, BODY))
                    self.assertIsNone(verifier.verify(b, TOOL, BODY))
                    self.assertEqual(other.verify(a, TOOL, BODY)[0], 403)
                    self.assertEqual(other.verify(c, TOOL, BODY)[0], 503)
                    self.assertEqual(other.verify(a, TOOL, BODY)[0], 403)
                    self.assertEqual(other.verify(b, TOOL, BODY)[0], 403)
                    self.assertEqual(verifier.nonce_cache_size, 2)
                # exp == now is still valid according to the verifier.
                with patch("worker_app.worker_auth.time.time", return_value=NOW + 10):
                    self.assertEqual(other.verify(a, TOOL, BODY)[0], 403)
                    self.assertEqual(other.verify(c, TOOL, BODY)[0], 503)
                with patch("worker_app.worker_auth.time.time", return_value=NOW + 11):
                    self.assertIsNone(other.verify(c, TOOL, BODY))
                    self.assertEqual(other.verify(b, TOOL, BODY)[0], 403)
                    self.assertEqual(other.verify(c, TOOL, BODY)[0], 403)
                    self.assertEqual(other.nonce_cache_size, 2)

    def test_sqlite_capacity_is_atomic_across_verifiers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = WorkerAuthConfig(shared_secret=SECRET, nonce_cache_max=2,
                                     nonce_store_path=Path(directory) / "nonces.db")
            verifiers = [WorkerAuthVerifier(config) for _ in range(8)]
            tokens = [sign(f"parallel-capacity-{i:04d}", NOW + 30) for i in range(8)]
            with patch("worker_app.worker_auth.time.time", return_value=NOW), ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda pair: pair[0].verify(pair[1], TOOL, BODY), zip(verifiers, tokens)))
                self.assertEqual(sum(result is None for result in results), 2)
                self.assertTrue(all(result is None or result[0] == 503 for result in results))
                for token, result in zip(tokens, results):
                    if result is None:
                        self.assertEqual(verifiers[0].verify(token, TOOL, BODY)[0], 403)
                self.assertEqual(verifiers[0].nonce_cache_size, 2)


if __name__ == "__main__":
    unittest.main()

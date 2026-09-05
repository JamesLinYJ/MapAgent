# +-------------------------------------------------------------------------
#
#   地理智能平台 - Worker 请求签名认证
#
#   文件:       worker_auth.py
#
#   日期:       2026年07月08日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.5
# --------------------------------------------------------------------------

"""Worker HMAC 请求认证与 nonce 重放防护。"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import hmac
import json
from pathlib import Path
import time
from typing import Any

from worker_app.lifecycle import LifecycleStoreError, SqliteNonceStore


@dataclass(slots=True)
class WorkerAuthConfig:
    shared_secret: str | None
    clock_skew_seconds: int = 30
    nonce_cache_max: int = 10000
    nonce_store_path: Path | None = None


@dataclass(slots=True)
class WorkerAuthVerifier:
    config: WorkerAuthConfig
    seen_nonces: dict[str, int] = field(default_factory=dict)
    nonce_store: SqliteNonceStore | None = field(init=False, default=None)

    def __post_init__(self) -> None:
        if self.config.nonce_store_path is not None:
            self.nonce_store = SqliteNonceStore(self.config.nonce_store_path)

    @property
    def nonce_cache_size(self) -> int:
        if self.nonce_store is not None:
            return self.nonce_store.size()
        return len(self.seen_nonces)

    def verify(self, authorization: str, tool_name: str, body: bytes) -> tuple[int, str] | None:
        if not self.config.shared_secret:
            return 503, "WORKER_SHARED_SECRET 未配置"
        return verify_worker_authorization(
            authorization=authorization,
            secret=self.config.shared_secret,
            tool_name=tool_name,
            body=body,
            seen_nonces=self.seen_nonces,
            clock_skew_seconds=self.config.clock_skew_seconds,
            nonce_cache_max=max(1, self.config.nonce_cache_max),
            nonce_store=self.nonce_store,
        )

    def purge_expired_nonces(self, now: int, reserve_slots: int = 0) -> None:
        if self.nonce_store is not None:
            self.nonce_store.purge_expired(now)
            return
        purge_expired_nonces(self.seen_nonces, now, max(1, self.config.nonce_cache_max), reserve_slots=reserve_slots)


def verify_worker_authorization(
    *,
    authorization: str,
    secret: str,
    tool_name: str,
    body: bytes,
    seen_nonces: dict[str, int],
    clock_skew_seconds: int,
    nonce_cache_max: int,
    nonce_store: SqliteNonceStore | None = None,
) -> tuple[int, str] | None:
    if not authorization:
        return 401, "缺少 Worker 授权头"
    prefix = "GeoAgentPlatform-Worker "
    if not authorization.startswith(prefix):
        return 403, "Worker 授权格式无效"
    token = authorization[len(prefix) :]
    try:
        encoded_payload, signature = token.split(".", 1)
    except ValueError:
        return 403, "Worker 授权 token 无效"
    expected_signature = hmac.new(secret.encode("utf-8"), encoded_payload.encode("utf-8"), hashlib.sha256).digest()
    actual_signature = base64url_decode(signature)
    if not hmac.compare_digest(actual_signature, expected_signature):
        return 403, "Worker 授权签名无效"
    try:
        payload = json.loads(base64url_decode(encoded_payload).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return 403, "Worker 授权 payload 无效"
    if not isinstance(payload, dict) or payload.get("v") != 1:
        return 403, "Worker 授权版本无效"
    if payload.get("toolName") != tool_name or not tool_name:
        return 403, "Worker 授权工具名不匹配"
    now = int(time.time())
    iat = int_payload(payload.get("iat"))
    exp = int_payload(payload.get("exp"))
    if iat is None or exp is None or iat > now + clock_skew_seconds or exp < now:
        return 403, "Worker 授权已过期或时间无效"
    body_hash = payload.get("bodyHash")
    expected_body_hash = hashlib.sha256(body).hexdigest()
    if not isinstance(body_hash, str) or not hmac.compare_digest(body_hash, expected_body_hash):
        return 403, "Worker 请求体哈希不匹配"
    nonce = payload.get("nonce")
    if not isinstance(nonce, str) or len(nonce) < 16:
        return 403, "Worker 授权 nonce 无效"
    if nonce_store is not None:
        try:
            accepted = nonce_store.consume(nonce, exp, now, nonce_cache_max)
        except LifecycleStoreError:
            return 503, "Worker nonce 存储不可用"
        if not accepted:
            return 403, "Worker 授权 nonce 已使用"
    else:
        purge_expired_nonces(seen_nonces, now, nonce_cache_max, reserve_slots=1)
        if nonce in seen_nonces:
            return 403, "Worker 授权 nonce 已使用"
        seen_nonces[nonce] = exp
    return None


def base64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("utf-8"))


def int_payload(value: Any) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


def purge_expired_nonces(
    seen_nonces: dict[str, int],
    now: int,
    nonce_cache_max: int,
    *,
    reserve_slots: int = 0,
) -> None:
    expired = [nonce for nonce, exp in seen_nonces.items() if exp < now]
    for nonce in expired:
        seen_nonces.pop(nonce, None)
    target_size = max(0, nonce_cache_max - reserve_slots)
    overflow = len(seen_nonces) - target_size
    if overflow > 0:
        sorted_by_exp = sorted(seen_nonces.items(), key=lambda item: item[1])
        for nonce, _exp in sorted_by_exp[:overflow]:
            seen_nonces.pop(nonce, None)

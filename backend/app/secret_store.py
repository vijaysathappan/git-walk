"""Authenticated encryption envelope for small user-owned API secrets."""

import base64
import hashlib
import hmac
import secrets

from .config import settings


def _key(label: bytes) -> bytes:
    return hmac.new(settings.auth_secret.encode("utf-8"), label, hashlib.sha256).digest()


def _stream(key: bytes, nonce: bytes, length: int) -> bytes:
    output = bytearray()
    counter = 0
    while len(output) < length:
        output.extend(
            hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        )
        counter += 1
    return bytes(output[:length])


def encrypt_secret(value: str) -> str:
    raw = value.encode("utf-8")
    nonce = secrets.token_bytes(16)
    stream = _stream(_key(b"gitwalk-secret-encryption"), nonce, len(raw))
    ciphertext = bytes(left ^ right for left, right in zip(raw, stream))
    tag = hmac.new(
        _key(b"gitwalk-secret-authentication"), nonce + ciphertext, hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(nonce + tag + ciphertext).decode("ascii")


def decrypt_secret(envelope: str) -> str:
    packed = base64.urlsafe_b64decode(envelope.encode("ascii"))
    if len(packed) < 48:
        raise ValueError("Invalid encrypted secret")
    nonce, tag, ciphertext = packed[:16], packed[16:48], packed[48:]
    expected = hmac.new(
        _key(b"gitwalk-secret-authentication"), nonce + ciphertext, hashlib.sha256
    ).digest()
    if not hmac.compare_digest(tag, expected):
        raise ValueError("Encrypted secret authentication failed")
    stream = _stream(_key(b"gitwalk-secret-encryption"), nonce, len(ciphertext))
    return bytes(left ^ right for left, right in zip(ciphertext, stream)).decode("utf-8")

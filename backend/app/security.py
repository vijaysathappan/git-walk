"""Passwordless email authentication and signed session tokens."""

import base64
import hashlib
import hmac
import json
import secrets
import smtplib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from fastapi import Header, HTTPException

from .config import settings
from .database import (
    auth_session_is_active,
    consume_login_code,
    create_auth_session,
    create_login_code,
    get_or_create_user,
    get_user,
    revoke_auth_session,
)


@dataclass(frozen=True)
class Principal:
    user_id: str
    email: str
    session_id: str | None = None


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def hash_login_code(email: str, code: str) -> str:
    payload = f"{email.lower()}:{code}".encode("utf-8")
    return hmac.new(settings.auth_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def create_session_token(user_id: str, email: str) -> str:
    expires = datetime.now(timezone.utc) + timedelta(hours=settings.session_hours)
    session_id = f"SES_{secrets.token_hex(12).upper()}"
    payload = _b64encode(
        json.dumps(
            {
                "sub": user_id,
                "email": email,
                "sid": session_id,
                "exp": int(expires.timestamp()),
            },
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signature = _b64encode(
        hmac.new(settings.auth_secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    )
    token = f"{payload}.{signature}"
    create_auth_session(
        session_id,
        user_id,
        hashlib.sha256(token.encode("utf-8")).hexdigest(),
        expires.isoformat(),
    )
    return token


def verify_session_token(token: str) -> Principal:
    try:
        payload, signature = token.split(".", 1)
        expected = _b64encode(
            hmac.new(settings.auth_secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        claims = json.loads(_b64decode(payload))
        if int(claims["exp"]) < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("expired")
        user = get_user(claims["sub"])
        if not user or user["email"].lower() != claims["email"].lower():
            raise ValueError("user")
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        if not auth_session_is_active(claims["sid"], user["user_id"], token_hash):
            raise ValueError("session")
        return Principal(
            user_id=user["user_id"], email=user["email"], session_id=claims["sid"]
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session.") from exc


def current_principal(authorization: str | None = Header(default=None)) -> Principal:
    if authorization and authorization.lower().startswith("bearer "):
        return verify_session_token(authorization.split(" ", 1)[1].strip())
    if not settings.auth_required:
        return Principal(user_id="USR_SYSTEM", email="system@local")
    raise HTTPException(status_code=401, detail="Sign in is required.")


def send_login_code(email: str) -> str | None:
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.otp_minutes)
    try:
        create_login_code(email, hash_login_code(email, code), expires_at.isoformat())
    except PermissionError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    if settings.smtp_user and settings.smtp_pass and settings.smtp_from:
        message = EmailMessage()
        message["Subject"] = "Your Git Walk sign-in code"
        message["From"] = settings.smtp_from
        message["To"] = email
        message.set_content(
            f"Your Git Walk verification code is {code}. "
            f"It expires in {settings.otp_minutes} minutes."
        )
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            smtp.starttls()
            smtp.login(settings.smtp_user, settings.smtp_pass)
            smtp.send_message(message)
        return None

    if settings.dev_show_otp:
        return code
    raise HTTPException(
        status_code=503,
        detail="Email delivery is not configured. Set SMTP_* values in backend/.env.",
    )


def verify_login_code(email: str, code: str) -> tuple[dict, str]:
    if not consume_login_code(email, hash_login_code(email, code)):
        raise HTTPException(status_code=401, detail="Invalid or expired verification code.")
    user = get_or_create_user(email)
    return user, create_session_token(user["user_id"], user["email"])


def logout_session(principal: Principal) -> None:
    if principal.session_id:
        revoke_auth_session(principal.session_id, principal.user_id)

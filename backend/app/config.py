"""Environment-backed application settings."""

import os
import secrets
from pathlib import Path


def _load_local_env() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_local_env()


def _local_auth_secret() -> str:
    configured = os.getenv("AUTH_SECRET", "").strip()
    if configured:
        return configured
    secret_path = Path(__file__).resolve().parent.parent / ".auth-secret"
    if secret_path.exists():
        return secret_path.read_text(encoding="utf-8").strip()
    generated = secrets.token_urlsafe(48)
    secret_path.write_text(generated, encoding="utf-8")
    return generated


def env_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    app_env = os.getenv("APP_ENV", "development").strip().lower()
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "")
    smtp_pass = os.getenv("SMTP_PASS", "")
    smtp_from = os.getenv("SMTP_FROM", smtp_user)
    auth_secret = _local_auth_secret()
    auth_required = env_bool("AUTH_REQUIRED", True)
    dev_show_otp = env_bool("DEV_SHOW_OTP", app_env == "development")
    session_hours = int(os.getenv("SESSION_HOURS", "24"))
    otp_minutes = int(os.getenv("OTP_MINUTES", "10"))
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_model = os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini")
    openrouter_models = [
        item.strip()
        for item in os.getenv("OPENROUTER_MODELS", openrouter_model).split(",")
        if item.strip()
    ]


settings = Settings()

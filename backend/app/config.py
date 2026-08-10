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
    if os.getenv("APP_ENV", "development").strip().lower() == "production":
        raise RuntimeError("AUTH_SECRET is required when APP_ENV=production")
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
    app_url = os.getenv("APP_URL", "https://localhost:3000").rstrip("/")
    api_base_url = os.getenv("API_BASE_URL", "http://localhost:8000").rstrip("/")
    office_addin_url = os.getenv("OFFICE_ADDIN_URL", app_url).rstrip("/")
    database_url = os.getenv("DATABASE_URL", "").strip()
    cors_origins = [
        item.strip().rstrip("/")
        for item in os.getenv("CORS_ORIGINS", app_url).split(",")
        if item.strip()
    ]
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
    otp_request_cooldown_seconds = int(os.getenv("OTP_REQUEST_COOLDOWN_SECONDS", "60"))
    otp_requests_per_hour = int(os.getenv("OTP_REQUESTS_PER_HOUR", "5"))
    max_upload_bytes = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
    max_xlsx_entries = int(os.getenv("MAX_XLSX_ENTRIES", "2500"))
    max_xlsx_uncompressed_bytes = int(
        os.getenv("MAX_XLSX_UNCOMPRESSED_BYTES", str(250 * 1024 * 1024))
    )
    max_workbook_sheets = int(os.getenv("MAX_WORKBOOK_SHEETS", "100"))
    max_workbook_rows = int(os.getenv("MAX_WORKBOOK_ROWS", "250000"))
    max_workbook_columns = int(os.getenv("MAX_WORKBOOK_COLUMNS", "1000"))
    upload_processing_timeout_seconds = int(
        os.getenv("UPLOAD_PROCESSING_TIMEOUT_SECONDS", "60")
    )
    temp_file_max_age_hours = int(os.getenv("TEMP_FILE_MAX_AGE_HOURS", "24"))
    log_level = os.getenv("LOG_LEVEL", "INFO").strip().upper()
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_model = os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini")
    openrouter_models = [
        item.strip()
        for item in os.getenv("OPENROUTER_MODELS", openrouter_model).split(",")
        if item.strip()
    ]


settings = Settings()

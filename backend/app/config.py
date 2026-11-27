import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_dotenv(REPO_DIR / ".env")

_default_db = (BACKEND_DIR / "codemap.db").resolve().as_posix()


def normalize_database_url(url: str) -> str:
    """Use the psycopg 3 driver for PostgreSQL URLs, whatever form they arrive in."""
    url = url.strip()
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Settings:
    def __init__(self) -> None:
        # A blank DATABASE_URL (e.g. an unfilled hosting setting) means "use the local SQLite file".
        self.database_url = normalize_database_url(os.environ.get("DATABASE_URL", "").strip() or f"sqlite:///{_default_db}")
        self.jwt_secret = os.environ.get("JWT_SECRET", "local-dev-change-me")
        self.storage_dir = Path(os.environ.get("UPLOAD_DIR", BACKEND_DIR / "storage"))
        self.demo_dir = Path(os.environ.get("DEMO_PROJECTS_DIR", REPO_DIR / "demo-projects"))
        self.static_dir = Path(os.environ.get("STATIC_DIR", REPO_DIR / "frontend" / "dist"))
        raw_origins = os.environ.get(
            "CORS_ORIGINS",
            "http://127.0.0.1:43123,http://localhost:43123",
        )
        self.cors_origins = [item.strip() for item in raw_origins.split(",") if item.strip()]


settings = Settings()

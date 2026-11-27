from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


def _engine_options(url: str) -> dict:
    if url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    parsed = make_url(url)
    connect_args: dict = {}
    # Azure Database for PostgreSQL only accepts encrypted connections.
    if "sslmode" not in parsed.query and (parsed.host or "").endswith(".postgres.database.azure.com"):
        connect_args["sslmode"] = "require"
    return {
        "connect_args": connect_args,
        # Azure closes idle connections; check each one before use and recycle regularly.
        "pool_pre_ping": True,
        "pool_recycle": 1800,
        "pool_size": 5,
        "max_overflow": 5,
    }


engine = create_engine(settings.database_url, **_engine_options(settings.database_url))
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def database_kind() -> str:
    """Human-readable database type, never including credentials."""
    url = make_url(settings.database_url)
    host = url.host or ""
    if url.get_backend_name() == "postgresql":
        return "Azure Database for PostgreSQL" if host.endswith(".postgres.database.azure.com") else "PostgreSQL"
    return url.get_backend_name()


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

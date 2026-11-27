import io
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

ALLOWED_SUFFIXES = {
    ".py",
    ".pyi",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".toml",
    ".yml",
    ".yaml",
}

MAX_UPLOAD = 8_000_000
MAX_FILES = 200
MAX_MEMBER = 1_000_000
MAX_TOTAL = 8_000_000
MAX_RATIO = 40
RATIO_FLOOR = 50_000


class ZipRejected(Exception):
    pass


def safe_extract(data: bytes, dest: Path) -> None:
    if len(data) > MAX_UPLOAD:
        raise ZipRejected("Zip is larger than 8 MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ZipRejected("Invalid zip file") from exc
    with archive:
        members = _members(archive)
        if not members:
            raise ZipRejected("Zip has no source files")
        dest.mkdir(parents=True, exist_ok=True)
        total = 0
        for info, relative in members:
            target = dest.joinpath(*Path(relative).parts)
            if not _inside(dest, target):
                raise ZipRejected("Zip contains an absolute path")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info, "r") as source:
                blob = source.read(MAX_MEMBER + 1)
            if len(blob) > MAX_MEMBER:
                raise ZipRejected("Zip member is too large")
            total += len(blob)
            if total > MAX_TOTAL:
                raise ZipRejected("Zip uncompressed size is too large")
            target.write_bytes(blob)


def install_zip(project_id: int, data: bytes) -> None:
    from app.config import settings

    root_dir = Path(settings.storage_dir)
    root_dir.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="src-", dir=root_dir))
    try:
        safe_extract(data, temporary)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    destination = root_dir / str(project_id)
    backup = root_dir / f".{project_id}.replacing"
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    if destination.exists():
        destination.rename(backup)
    try:
        temporary.rename(destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        if backup.exists() and not destination.exists():
            backup.rename(destination)
        raise
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)


def _members(archive: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, str]]:
    chosen: list[tuple[zipfile.ZipInfo, str]] = []
    total = 0
    for info in archive.infolist():
        if info.is_dir() or info.filename.endswith("/"):
            continue
        raw_name = info.filename.replace("\\", "/")
        base_name = raw_name.rsplit("/", 1)[-1]
        if raw_name.startswith("__MACOSX/") or "/__MACOSX/" in f"/{raw_name}" or base_name.startswith("._"):
            continue
        relative = _safe_relative(raw_name)
        if _is_symlink(info):
            raise ZipRejected("Zip contains a symlink")
        suffix = Path(relative).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            raise ZipRejected(f"Disallowed file type: {relative}")
        if info.file_size > MAX_MEMBER:
            raise ZipRejected("Zip member is too large")
        compressed = max(info.compress_size, 1)
        if info.file_size > RATIO_FLOOR and info.file_size / compressed > MAX_RATIO:
            raise ZipRejected("Zip compression ratio is too high")
        total += info.file_size
        if total > MAX_TOTAL:
            raise ZipRejected("Zip uncompressed size is too large")
        chosen.append((info, relative))
    if len(chosen) > MAX_FILES:
        raise ZipRejected("Zip has too many files")
    return chosen


def _safe_relative(name: str) -> str:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ZipRejected("Zip contains an absolute path")
    parts: list[str] = []
    for part in normalized.split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            raise ZipRejected("Zip contains a parent directory segment")
        parts.append(part)
    if not parts:
        raise ZipRejected("Zip contains an invalid path")
    return "/".join(parts)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = info.external_attr >> 16
    return stat.S_ISLNK(mode)


def _inside(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True

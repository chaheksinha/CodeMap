import io
import stat
import zipfile
from pathlib import Path

import pytest

from app.services.zipsafe import ZipRejected, safe_extract


def build_zip(entries: list[tuple[str, bytes]], attrs: dict[str, int] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, payload in entries:
            info = zipfile.ZipInfo(filename=name)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.date_time = (2024, 1, 1, 0, 0, 0)
            if attrs and name in attrs:
                info.external_attr = attrs[name]
            else:
                info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, payload)
    return buffer.getvalue()


def test_rejects_parent_traversal(tmp_path: Path) -> None:
    dest = tmp_path / "out"
    with pytest.raises(ZipRejected, match="parent"):
        safe_extract(build_zip([("../evil.py", b"x = 1\n")]), dest)
    assert not dest.exists()


def test_rejects_backslash_traversal(tmp_path: Path) -> None:
    with pytest.raises(ZipRejected, match="parent"):
        safe_extract(build_zip([(r"..\evil.py", b"x = 1\n")]), tmp_path / "out")


def test_rejects_absolute_posix_path(tmp_path: Path) -> None:
    with pytest.raises(ZipRejected, match="absolute"):
        safe_extract(build_zip([("/tmp/evil.py", b"x = 1\n")]), tmp_path / "out")


def test_rejects_windows_drive_path(tmp_path: Path) -> None:
    with pytest.raises(ZipRejected, match="absolute"):
        safe_extract(build_zip([("C:/evil.py", b"x = 1\n")]), tmp_path / "out")


def test_rejects_exe(tmp_path: Path) -> None:
    with pytest.raises(ZipRejected, match="Disallowed"):
        safe_extract(build_zip([("app/run.exe", b"MZ")]), tmp_path / "out")


def test_rejects_symlink(tmp_path: Path) -> None:
    mode = (stat.S_IFLNK | 0o777) << 16
    data = build_zip([("link.py", b"target.py")], attrs={"link.py": mode})
    with pytest.raises(ZipRejected, match="symlink"):
        safe_extract(data, tmp_path / "out")


def test_extracts_python_file(tmp_path: Path) -> None:
    dest = tmp_path / "out"
    safe_extract(build_zip([("svc/main.py", b"value = 1\n")]), dest)
    assert (dest / "svc" / "main.py").read_bytes() == b"value = 1\n"


def test_skips_macosx_metadata(tmp_path: Path) -> None:
    dest = tmp_path / "out"
    safe_extract(
        build_zip(
            [
                ("__MACOSX/._main.py", b"bad"),
                ("svc/main.py", b"value = 1\n"),
            ]
        ),
        dest,
    )
    assert (dest / "svc" / "main.py").read_bytes() == b"value = 1\n"
    assert not (dest / "__MACOSX").exists()


def test_rejects_empty_archive(tmp_path: Path) -> None:
    with pytest.raises(ZipRejected, match="Zip has no source files"):
        safe_extract(build_zip([("__MACOSX/._skip.py", b"nope")]), tmp_path / "out")


def test_rejects_too_many_files(tmp_path: Path) -> None:
    entries = [(f"pkg/f{index}.py", b"x = 1\n") for index in range(201)]
    with pytest.raises(ZipRejected, match="too many"):
        safe_extract(build_zip(entries), tmp_path / "out")


def test_rejects_compression_bomb(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("bomb.py", b"A" * 60_000)
    with pytest.raises(ZipRejected, match="compression"):
        safe_extract(buffer.getvalue(), tmp_path / "out")

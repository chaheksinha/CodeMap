import os
import shutil
from pathlib import Path

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    AnalysisJob,
    ArchitectureIntent,
    AuditLog,
    Component,
    DriftAlert,
    Project,
    Relationship,
    SourceUpload,
    User,
)
from app.services.analyzer import CODE_EXTENSIONS, SKIP_DIRS
from app.services.audit import log_action
from app.services.rebuild import rebuild

DEMO_NAME = "Demo microservices"
DEMO_DESCRIPTION = "The order service calls notifications only at runtime."


def load_demo(db: Session, user: User) -> Project:
    demo_root = Path(settings.demo_dir) / "demo-microservices-app"
    trace_path = demo_root / "traces" / "otel-traces.json"
    if not demo_root.is_dir() or not trace_path.is_file():
        raise FileNotFoundError(str(demo_root))
    project = Project(
        user_id=user.id,
        name=DEMO_NAME,
        description=DEMO_DESCRIPTION,
        source_name="demo-microservices-app",
        trace_name=trace_path.name,
    )
    db.add(project)
    db.flush()
    destination = Path(settings.storage_dir) / str(project.id)
    _copy_code(demo_root, destination)
    project.trace_json = trace_path.read_text(encoding="utf-8")
    log_action(db, user_id=user.id, project_id=project.id, action="demo", detail=DEMO_NAME)
    rebuild(db, project)
    return project


def remove_project(db: Session, user: User, project: Project) -> None:
    project_id = project.id
    name = project.name
    log_action(db, user_id=user.id, project_id=None, action="delete project", detail=name)
    for model in (Component, Relationship, ArchitectureIntent, DriftAlert, AnalysisJob, AuditLog, SourceUpload):
        db.execute(delete(model).where(model.project_id == project_id))
    db.delete(project)
    db.commit()
    root = Path(settings.storage_dir) / str(project_id)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)


def _copy_code(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(source):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS and not name.startswith(".")]
        for filename in filenames:
            if filename.startswith(".") or Path(filename).suffix.lower() not in CODE_EXTENSIONS:
                continue
            full = Path(dirpath) / filename
            if full.is_symlink():
                continue
            relative = full.relative_to(source)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(full.read_bytes())

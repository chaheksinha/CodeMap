from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import current_user, project_or_404
from app.models import ArchitectureIntent, Component, DriftAlert, Project, SourceUpload, User
from app.services.audit import log_action
from app.services.demo import load_demo, remove_project
from app.services.rebuild import rebuild
from app.services.snapshot import build_report, build_snapshot, iso
from app.services.trace import TraceRejected, parse_trace
from app.services.zipsafe import ZipRejected, install_zip

router = APIRouter()

_VIEWS = {"static", "runtime", "combined", "intended"}
_MAX_ZIP = 8_000_000
_MAX_TRACE = 2_000_000


class ProjectIn(BaseModel):
    name: str
    description: str | None = None


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None


class IntentIn(BaseModel):
    source: str
    target: str


class AlertIn(BaseModel):
    status: str


def _view(view: str) -> str:
    if view not in _VIEWS:
        raise HTTPException(status_code=400, detail="Invalid view")
    return view


@router.get("/projects")
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(
        select(Project).where(Project.user_id == user.id).order_by(Project.created_at.desc(), Project.id.desc())
    )
    payload = []
    for project in rows:
        open_alerts = db.scalar(
            select(func.count())
            .select_from(DriftAlert)
            .where(DriftAlert.project_id == project.id, DriftAlert.status == "open")
        )
        high_alerts = db.scalar(
            select(func.count())
            .select_from(DriftAlert)
            .where(
                DriftAlert.project_id == project.id,
                DriftAlert.status == "open",
                DriftAlert.severity == "high",
            )
        )
        component_count = db.scalar(
            select(func.count())
            .select_from(Component)
            .where(Component.project_id == project.id, Component.kind != "file")
        )
        payload.append(
            {
                "id": project.id,
                "name": project.name,
                "description": project.description,
                "open_alerts": int(open_alerts or 0),
                "high_alerts": int(high_alerts or 0),
                "component_count": int(component_count or 0),
                "source_name": project.source_name,
                "trace_name": project.trace_name,
                "created_at": iso(project.created_at),
            }
        )
    return payload


@router.post("/projects")
def create_project(
    body: ProjectIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(name) > 80:
        raise HTTPException(status_code=400, detail="Name must be at most 80 characters")
    description = (body.description or "").strip()
    project = Project(user_id=user.id, name=name, description=description)
    db.add(project)
    db.flush()
    log_action(db, user_id=user.id, project_id=project.id, action="create", detail=name)
    db.commit()
    return build_snapshot(db, project, "combined")


@router.patch("/projects/{project_id}")
def update_project(
    project_id: int,
    body: ProjectPatch,
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        if len(name) > 80:
            raise HTTPException(status_code=400, detail="Name must be at most 80 characters")
        project.name = name
    if body.description is not None:
        project.description = body.description.strip()
    log_action(db, user_id=user.id, project_id=project.id, action="rename", detail=project.name)
    db.commit()
    return build_snapshot(db, project, chosen)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    project = project_or_404(db, user, project_id)
    remove_project(db, user, project)
    return Response(status_code=204)


@router.get("/projects/{project_id}")
def get_project(
    project_id: int,
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = project_or_404(db, user, project_id)
    return build_snapshot(db, project, _view(view))


@router.post("/projects/{project_id}/source")
def upload_source(
    project_id: int,
    file: UploadFile = File(...),
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    data = file.file.read()
    if len(data) > _MAX_ZIP:
        raise HTTPException(status_code=400, detail="Zip is larger than 8 MB")
    try:
        install_zip(project.id, data)
    except ZipRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    project.source_name = file.filename or "upload.zip"
    db.add(SourceUpload(project_id=project.id, filename=project.source_name, byte_size=len(data)))
    log_action(db, user_id=user.id, project_id=project.id, action="upload source", detail=project.source_name)
    rebuild(db, project)
    return build_snapshot(db, project, chosen)


@router.post("/projects/{project_id}/trace")
def upload_trace(
    project_id: int,
    file: UploadFile = File(...),
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    data = file.file.read()
    if len(data) > _MAX_TRACE:
        raise HTTPException(status_code=400, detail="Trace is larger than 2 MB")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Trace must be UTF-8 JSON") from exc
    try:
        parse_trace(text)
    except TraceRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    project.trace_json = text
    project.trace_name = file.filename or "trace.json"
    log_action(db, user_id=user.id, project_id=project.id, action="upload trace", detail=project.trace_name)
    rebuild(db, project)
    return build_snapshot(db, project, chosen)


@router.post("/projects/{project_id}/intents")
def add_intent(
    project_id: int,
    body: IntentIn,
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    source = body.source.strip()
    target = body.target.strip()
    if not source or not target:
        raise HTTPException(status_code=400, detail="Source and target are required")
    if source == target:
        raise HTTPException(status_code=400, detail="Source and target must be different")
    existing = db.scalar(
        select(ArchitectureIntent).where(
            ArchitectureIntent.project_id == project.id,
            ArchitectureIntent.source == source,
            ArchitectureIntent.target == target,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="Intent already exists")
    db.add(ArchitectureIntent(project_id=project.id, source=source, target=target))
    log_action(db, user_id=user.id, project_id=project.id, action="add intent", detail=f"{source} → {target}")
    rebuild(db, project)
    return build_snapshot(db, project, chosen)


@router.delete("/projects/{project_id}/intents/{intent_id}")
def delete_intent(
    project_id: int,
    intent_id: int,
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    intent = db.get(ArchitectureIntent, intent_id)
    if intent is None or intent.project_id != project.id:
        raise HTTPException(status_code=404, detail="Intent not found")
    detail = f"{intent.source} → {intent.target}"
    db.delete(intent)
    log_action(db, user_id=user.id, project_id=project.id, action="delete intent", detail=detail)
    rebuild(db, project)
    return build_snapshot(db, project, chosen)


@router.patch("/projects/{project_id}/alerts/{alert_id}")
def update_alert(
    project_id: int,
    alert_id: int,
    body: AlertIn,
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    project = project_or_404(db, user, project_id)
    if body.status not in {"open", "dismissed"}:
        raise HTTPException(status_code=400, detail="Status must be open or dismissed")
    alert = db.get(DriftAlert, alert_id)
    if alert is None or alert.project_id != project.id:
        raise HTTPException(status_code=404, detail="Alert not found")
    alert.status = body.status
    db.commit()
    return build_snapshot(db, project, chosen)


@router.get("/projects/{project_id}/report")
def project_report(
    project_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = project_or_404(db, user, project_id)
    return build_report(db, project)


@router.post("/demo")
def create_demo(
    view: str = Query("combined"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    chosen = _view(view)
    try:
        project = load_demo(db, user)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail="Demo project files are missing") from exc
    return build_snapshot(db, project, chosen)

import json
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import AnalysisJob, ArchitectureIntent, Component, DriftAlert, Project, Relationship
from app.services.analyzer import Analysis, analyze_directory, empty_analysis
from app.services.drift import AlertDraft, RuntimeLink, alerts_for, resolve_runtime
from app.services.trace import parse_trace


def rebuild(db: Session, project: Project) -> None:
    db.flush()
    project_id = project.id
    remembered = {
        (row.kind, row.source, row.target): row.status
        for row in db.scalars(select(DriftAlert).where(DriftAlert.project_id == project_id))
    }
    for model in (Component, Relationship, DriftAlert, AnalysisJob):
        db.execute(delete(model).where(model.project_id == project_id))
    db.flush()

    source_dir = Path(settings.storage_dir) / str(project_id)
    analysis = analyze_directory(source_dir) if source_dir.is_dir() else empty_analysis()
    calls = parse_trace(project.trace_json) if project.trace_json else []
    intent_rows = list(
        db.scalars(
            select(ArchitectureIntent)
            .where(ArchitectureIntent.project_id == project_id)
            .order_by(ArchitectureIntent.id)
        )
    )
    intent_pairs = [(row.source, row.target) for row in intent_rows]
    links = resolve_runtime(analysis, calls)
    drafts = alerts_for(analysis, links, intent_pairs)
    _store(db, project_id, analysis, links, intent_pairs, drafts, remembered)
    db.add(
        AnalysisJob(
            project_id=project_id,
            status="completed",
            summary=f"{len(analysis.files)} files, {len(links)} runtime calls, {len(drafts)} alerts",
        )
    )
    db.commit()


def _store(
    db: Session,
    project_id: int,
    analysis: Analysis,
    links: list[RuntimeLink],
    intent_pairs: list[tuple[str, str]],
    drafts: list[AlertDraft],
    remembered: dict[tuple[str, str, str], str],
) -> None:
    services = dict(analysis.services)
    for link in links:
        services.setdefault(link.source, 0)
    databases = set(analysis.databases)
    externals = dict(analysis.externals)
    for link in links:
        if link.target_key.startswith("external:"):
            externals.setdefault(link.target_key, link.target_label)

    for name in sorted(services):
        count = services[name]
        noun = "file" if count == 1 else "files"
        db.add(Component(project_id=project_id, key=name, label=name, kind="service", detail=f"{count} {noun}"))
    for name in sorted(databases):
        db.add(Component(project_id=project_id, key=name, label=name, kind="database", detail=""))
    for key, label in sorted(externals.items()):
        db.add(Component(project_id=project_id, key=key, label=label, kind="external", detail=""))
    for record in analysis.files:
        db.add(
            Component(
                project_id=project_id,
                key=record.path,
                label=record.path,
                kind="file",
                detail=json.dumps(
                    {
                        "symbols": record.symbols,
                        "routes": record.routes,
                        "libraries": record.libraries,
                        "imports": record.imports,
                    },
                    ensure_ascii=False,
                ),
            )
        )
        for route in record.routes:
            api_key = f"api:{record.path}:{route}"
            db.add(
                Component(
                    project_id=project_id,
                    key=api_key,
                    label=route,
                    kind="api",
                    detail=record.path,
                )
            )
            db.add(
                Relationship(
                    project_id=project_id,
                    source_key=record.service,
                    target_key=api_key,
                    kind="exposes",
                    origin="static",
                    label=route,
                )
            )
    for edge in analysis.edges:
        db.add(
            Relationship(
                project_id=project_id,
                source_key=edge.source,
                target_key=edge.target,
                kind=edge.kind,
                origin=edge.origin,
                label=edge.label,
            )
        )
    for link in links:
        db.add(
            Relationship(
                project_id=project_id,
                source_key=link.source,
                target_key=link.target_key,
                kind="call",
                origin="runtime",
                label=link.operation,
            )
        )
    for source, target in intent_pairs:
        db.add(
            Relationship(
                project_id=project_id,
                source_key=_intent_key(source, services, databases, externals),
                target_key=_intent_key(target, services, databases, externals),
                kind="call",
                origin="intended",
                label="",
            )
        )
    for draft in drafts:
        status = remembered.get((draft.kind, draft.source, draft.target), "open")
        if status not in {"open", "dismissed"}:
            status = "open"
        db.add(
            DriftAlert(
                project_id=project_id,
                severity=draft.severity,
                kind=draft.kind,
                title=draft.title,
                source=draft.source,
                target=draft.target,
                description=draft.description,
                status=status,
            )
        )


def _intent_key(name: str, services: dict[str, int], databases: set[str], externals: dict[str, str]) -> str:
    if name in services:
        return name
    for database in databases:
        if database.lower() == name.lower():
            return database
    for key, label in externals.items():
        if name == key or name == label:
            return key
    return name

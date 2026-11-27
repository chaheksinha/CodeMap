import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ArchitectureIntent, AuditLog, Component, DriftAlert, Project, Relationship
from app.services.analyzer import service_of

_GRAPH_KINDS = {"service", "database", "external", "api"}


def build_snapshot(db: Session, project: Project, view: str) -> dict:
    components = list(db.scalars(select(Component).where(Component.project_id == project.id).order_by(Component.id)))
    relationships = list(
        db.scalars(select(Relationship).where(Relationship.project_id == project.id).order_by(Relationship.id))
    )
    alerts = list(db.scalars(select(DriftAlert).where(DriftAlert.project_id == project.id).order_by(DriftAlert.id)))
    intents = list(
        db.scalars(
            select(ArchitectureIntent).where(ArchitectureIntent.project_id == project.id).order_by(ArchitectureIntent.id)
        )
    )
    activity = list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.project_id == project.id)
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(8)
        )
    )
    nodes, edges = _graph(view, components, relationships, alerts)
    return {
        "project": {
            "id": project.id,
            "name": project.name,
            "description": project.description,
            "trace_name": project.trace_name,
            "source_name": project.source_name,
        },
        "view": view,
        "stats": _stats(components, relationships, alerts),
        "severities": _severities(alerts),
        "nodes": nodes,
        "edges": edges,
        "files": _files(components),
        "alerts": [_alert(row) for row in alerts],
        "intents": [{"id": row.id, "source": row.source, "target": row.target} for row in intents],
        "activity": [
            {"action": row.action, "detail": row.detail, "created_at": iso(row.created_at)} for row in activity
        ],
    }


def build_report(db: Session, project: Project) -> dict:
    snapshot = build_snapshot(db, project, "combined")
    relationships = list(
        db.scalars(select(Relationship).where(Relationship.project_id == project.id).order_by(Relationship.id))
    )
    return {
        "project": snapshot["project"],
        "stats": snapshot["stats"],
        "severities": snapshot["severities"],
        "alerts": snapshot["alerts"],
        "static_pairs": _pairs(relationships, "static"),
        "runtime_pairs": _pairs(relationships, "runtime"),
        "intents": snapshot["intents"],
        "activity": snapshot["activity"],
    }


def iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds") + "Z"


def _stats(components: list[Component], relationships: list[Relationship], alerts: list[DriftAlert]) -> dict:
    return {
        "components": len(components),
        "static_links": sum(1 for row in relationships if row.origin == "static" and row.kind in {"call", "database"}),
        "runtime_calls": sum(1 for row in relationships if row.origin == "runtime"),
        "open_alerts": sum(1 for row in alerts if row.status == "open"),
    }


def _severities(alerts: list[DriftAlert]) -> dict:
    counts = {"high": 0, "medium": 0, "low": 0}
    for row in alerts:
        if row.status == "open" and row.severity in counts:
            counts[row.severity] += 1
    return counts


def _graph(
    view: str,
    components: list[Component],
    relationships: list[Relationship],
    alerts: list[DriftAlert],
) -> tuple[list[dict], list[dict]]:
    graph = [row for row in components if row.kind in _GRAPH_KINDS]
    by_key = {row.key: row for row in graph}
    hot = _hot_labels(alerts)
    if view == "static":
        edges = [row for row in relationships if row.origin == "static" and row.kind in {"call", "database", "exposes"}]
        nodes = [row for row in graph if row.kind in {"service", "database", "api"}]
        return _sort_nodes([_graph_node(row, hot) for row in nodes]), _sort_edges(edges, by_key)
    if view == "runtime":
        edges = [row for row in relationships if row.origin == "runtime"]
        return _endpoint_nodes(edges, by_key, hot), _sort_edges(edges, by_key)
    if view == "intended":
        edges = [row for row in relationships if row.origin == "intended"]
        return _intended_nodes(edges, by_key, hot), _sort_edges(edges, by_key)
    edges = [
        row
        for row in relationships
        if row.origin in {"static", "runtime", "intended"} and row.kind not in {"import"}
    ]
    nodes = [_graph_node(row, hot) for row in graph]
    return _sort_nodes(nodes), _sort_edges(edges, by_key)


def _endpoint_nodes(edges: list[Relationship], by_key: dict[str, Component], hot: set[str]) -> list[dict]:
    nodes: list[dict] = []
    seen: set[str] = set()
    for row in edges:
        for key in (row.source_key, row.target_key):
            if key in seen:
                continue
            seen.add(key)
            component = by_key.get(key)
            if component is None:
                label, kind = _synthetic(key)
                nodes.append(_node(key, label, kind, hot))
            else:
                nodes.append(_graph_node(component, hot))
    return _sort_nodes(nodes)


def _intended_nodes(edges: list[Relationship], by_key: dict[str, Component], hot: set[str]) -> list[dict]:
    return _endpoint_nodes(edges, by_key, hot)


def _synthetic(key: str) -> tuple[str, str]:
    if key.startswith("external:"):
        return key.split(":", 1)[1], "external"
    return key, "service"


def _node(key: str, label: str, kind: str, hot: set[str], service: str | None = None) -> dict:
    payload = {
        "id": key,
        "label": label,
        "kind": kind,
        "warn": label in hot,
        "width": node_width(label),
    }
    if service:
        payload["service"] = service
    return payload


def node_width(label: str) -> int:
    return max(96, min(180, 64 + 8 * len(label)))


def _hot_labels(alerts: list[DriftAlert]) -> set[str]:
    names: set[str] = set()
    for row in alerts:
        if row.status == "open" and row.severity == "high":
            names.add(row.source)
            names.add(row.target)
    return names


def _sort_nodes(nodes: list[dict]) -> list[dict]:
    return sorted(nodes, key=lambda item: (item["label"].lower(), str(item["id"])))


def _graph_node(row: Component, hot: set[str]) -> dict:
    service = None
    if row.kind == "api" and row.detail:
        service = service_of(row.detail)
    elif row.kind == "service":
        service = row.label
    return _node(row.key, row.label, row.kind, hot, service)


def _sort_edges(rows: list[Relationship], by_key: dict[str, Component] | None = None) -> list[dict]:
    edges = [_edge(row, by_key) for row in rows]
    return sorted(edges, key=lambda item: int(item["id"]))


def _edge(row: Relationship, by_key: dict[str, Component] | None = None) -> dict:
    if row.origin == "runtime":
        kind = "runtime_call"
    elif row.origin == "intended":
        kind = "intended"
    elif row.kind == "database":
        kind = "reads"
    elif row.kind == "import":
        kind = "import"
    elif row.kind == "exposes":
        kind = "exposes"
    else:
        kind = "call"
    return {
        "id": str(row.id),
        "source": row.source_key,
        "target": row.target_key,
        "kind": kind,
        "origin": row.origin,
        "source_name": _label_for(row.source_key, by_key),
        "target_name": _label_for(row.target_key, by_key),
        "label": client_label(row.label),
    }


def _label_for(key: str, by_key: dict[str, Component] | None) -> str:
    if by_key and key in by_key:
        return by_key[key].label
    return _display(key)


def client_label(value: str) -> str:
    text = " ".join((value or "").split())
    if len(text) <= 40:
        return text
    return text[:40]


def _files(components: list[Component]) -> list[dict]:
    rows = []
    for component in components:
        if component.kind != "file":
            continue
        try:
            detail = json.loads(component.detail or "{}")
        except json.JSONDecodeError:
            detail = {}
        if not isinstance(detail, dict):
            detail = {}
        rows.append(
            {
                "path": component.key,
                "service": service_of(component.key),
                "symbols": _strings(detail.get("symbols")),
                "routes": _strings(detail.get("routes")),
                "libraries": _strings(detail.get("libraries")),
                "imports": _strings(detail.get("imports")),
            }
        )
    return sorted(rows, key=lambda item: item["path"])


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _alert(row: DriftAlert) -> dict:
    return {
        "id": row.id,
        "severity": row.severity,
        "kind": row.kind,
        "title": row.title,
        "source": row.source,
        "target": row.target,
        "description": row.description,
        "status": row.status,
    }


def _pairs(relationships: list[Relationship], origin: str) -> list[dict]:
    found: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for row in relationships:
        if row.origin != origin:
            continue
        if origin == "static" and row.kind not in {"call", "database"}:
            continue
        if origin == "runtime" and row.kind != "call":
            continue
        pair = (_display(row.source_key), _display(row.target_key))
        if pair in seen:
            continue
        seen.add(pair)
        found.append({"source": pair[0], "target": pair[1]})
    found.sort(key=lambda item: (item["source"], item["target"]))
    return found


def _display(key: str) -> str:
    if key.startswith("external:"):
        return key.split(":", 1)[1]
    return key

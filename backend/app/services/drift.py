from dataclasses import dataclass

from app.services.analyzer import Analysis
from app.services.trace import TraceCall


@dataclass
class AlertDraft:
    severity: str
    kind: str
    title: str
    source: str
    target: str
    description: str


@dataclass
class RuntimeLink:
    source: str
    target_key: str
    target_label: str
    operation: str


def resolve_runtime(analysis: Analysis, calls: list[TraceCall]) -> list[RuntimeLink]:
    databases = {name.lower(): name for name in analysis.databases}
    links: list[RuntimeLink] = []
    seen: set[tuple[str, str, str]] = set()
    for call in calls:
        target = call.target.strip()
        if "://" in target:
            host = target.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0]
        else:
            host = target.split(":", 1)[0]
        if not call.source or not host:
            continue
        if host in analysis.services:
            key, label = host, host
        elif host.lower() in databases:
            label = databases[host.lower()]
            key = label
        else:
            label = host
            key = host if host.startswith("external:") else f"external:{host}"
        item = (call.source, key, call.operation)
        if item in seen:
            continue
        seen.add(item)
        links.append(RuntimeLink(call.source, key, label, call.operation))
    return links


def static_pairs(analysis: Analysis) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for edge in analysis.edges:
        if edge.origin != "static" or edge.kind not in {"call", "database"}:
            continue
        target = edge.target
        if target.startswith("external:"):
            target = analysis.externals.get(target, target.split(":", 1)[1])
        pairs.add((edge.source, target))
    return pairs


def alerts_for(analysis: Analysis, links: list[RuntimeLink], intents: list[tuple[str, str]]) -> list[AlertDraft]:
    runtime = {(link.source, link.target_label) for link in links}
    return detect(static_pairs(analysis), runtime, set(intents), set(analysis.services), set(analysis.databases))


def compute_drift(analysis: Analysis, calls: list[TraceCall], intents: list[tuple[str, str]]) -> list[AlertDraft]:
    return alerts_for(analysis, resolve_runtime(analysis, calls), intents)


def detect(
    static_pairs: set[tuple[str, str]],
    runtime_pairs: set[tuple[str, str]],
    intent_pairs: set[tuple[str, str]],
    known_services: set[str],
    db_names: set[str],
) -> list[AlertDraft]:
    alerts: list[AlertDraft] = []
    internal = known_services | db_names
    for source, target in sorted(runtime_pairs):
        if target not in internal:
            alerts.append(
                AlertDraft(
                    "high",
                    "unexpected_external",
                    "Unexpected external connection",
                    source,
                    target,
                    f"{source} calls {target} at runtime, and that target is not a service in this project.",
                )
            )
        elif (source, target) not in static_pairs:
            alerts.append(
                AlertDraft(
                    "high",
                    "undocumented_runtime",
                    "Undocumented runtime connection",
                    source,
                    target,
                    f"{source} calls {target} in the trace, and the source never does.",
                )
            )
    if runtime_pairs:
        for source, target in sorted(static_pairs):
            if (source, target) not in runtime_pairs:
                alerts.append(
                    AlertDraft(
                        "medium",
                        "unobserved_static",
                        "Unobserved static dependency",
                        source,
                        target,
                        f"{source} depends on {target} in the source, and the trace never shows that call.",
                    )
                )
    for source, target in sorted(intent_pairs):
        if (source, target) not in static_pairs and (source, target) not in runtime_pairs:
            alerts.append(
                AlertDraft(
                    "medium",
                    "missing_intended",
                    "Missing intended connection",
                    source,
                    target,
                    f"You marked {source} -> {target} as intended, and neither the source nor the trace shows it.",
                )
            )
    return alerts

import json
from dataclasses import dataclass


class TraceRejected(Exception):
    pass


@dataclass
class TraceCall:
    source: str
    target: str
    operation: str


def parse_trace(text: str) -> list[TraceCall]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TraceRejected("Trace is not valid JSON") from exc
    if not isinstance(data, dict):
        raise TraceRejected("Trace format was not recognized")
    if "resourceSpans" in data:
        calls = _otel_calls(data)
    elif "calls" in data:
        calls = _simple_calls(data)
    else:
        raise TraceRejected("Trace format was not recognized")
    if not calls:
        raise TraceRejected("Trace does not contain any calls")
    return calls


def _simple_calls(data: dict) -> list[TraceCall]:
    raw_calls = data.get("calls")
    if not isinstance(raw_calls, list):
        raise TraceRejected("Trace format was not recognized")
    calls: list[TraceCall] = []
    for item in raw_calls:
        if not isinstance(item, dict):
            continue
        source = str(item.get("from") or "").strip()
        target = str(item.get("to") or "").strip()
        operation = str(item.get("operation") or "").strip()
        if source and target:
            calls.append(TraceCall(source, target, operation))
    return calls


def _otel_calls(data: dict) -> list[TraceCall]:
    resources = data.get("resourceSpans")
    if not isinstance(resources, list):
        raise TraceRejected("Trace format was not recognized")
    calls: list[TraceCall] = []
    for resource_span in resources:
        if not isinstance(resource_span, dict):
            continue
        resource = resource_span.get("resource")
        attributes = _attrs(resource.get("attributes") if isinstance(resource, dict) else None)
        service = attributes.get("service.name", "").strip()
        if not service:
            continue
        scopes = resource_span.get("scopeSpans")
        if not isinstance(scopes, list):
            scopes = resource_span.get("instrumentationLibrarySpans")
        if not isinstance(scopes, list):
            continue
        for scope in scopes:
            if not isinstance(scope, dict):
                continue
            spans = scope.get("spans")
            if not isinstance(spans, list):
                continue
            for span in spans:
                if not isinstance(span, dict):
                    continue
                span_attributes = _attrs(span.get("attributes"))
                target = (
                    span_attributes.get("peer.service")
                    or span_attributes.get("http.url")
                    or span_attributes.get("url.full")
                    or ""
                ).strip()
                if not target:
                    continue
                operation = str(span.get("name") or "").strip()
                calls.append(TraceCall(service, target, operation))
    return calls


def _attrs(raw: object) -> dict[str, str]:
    if isinstance(raw, dict):
        return {str(key): _stringify(value) for key, value in raw.items()}
    if isinstance(raw, list):
        found: dict[str, str] = {}
        for item in raw:
            if isinstance(item, dict) and "key" in item:
                found[str(item["key"])] = _stringify(item.get("value"))
        return found
    return {}


def _stringify(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("stringValue", "string_value", "intValue", "int_value", "boolValue", "doubleValue"):
            if key in value and value[key] is not None:
                return _stringify(value[key])
    return ""

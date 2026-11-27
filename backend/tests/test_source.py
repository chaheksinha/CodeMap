import json
from pathlib import Path

import pytest

from app.services.analyzer import analyze_directory
from app.services.drift import compute_drift, static_pairs
from app.services.trace import TraceRejected, parse_trace

DEMO = Path(__file__).resolve().parents[2] / "demo-projects" / "demo-microservices-app"


def test_demo_static_pairs_and_imports() -> None:
    analysis = analyze_directory(DEMO)
    pairs = static_pairs(analysis)
    assert ("api-gateway", "user-service") in pairs
    assert ("api-gateway", "order-service") in pairs
    assert ("order-service", "user-service") in pairs
    assert ("user-service", "MySQL") in pairs
    assert ("order-service", "notification-service") not in pairs

    imports = {(edge.source, edge.target) for edge in analysis.edges if edge.kind == "import" and edge.origin == "static"}
    assert ("user-service/main.py", "user-service/models.py") in imports
    assert ("api-gateway/client.ts", "api-gateway/format.ts") in imports

    assert ("database", "user-service", "MySQL") in {(edge.kind, edge.source, edge.target) for edge in analysis.edges}
    assert not any("127.0.0.1" in edge.target or "localhost" in edge.target for edge in analysis.edges)
    assert all(not record.path.startswith("traces/") for record in analysis.files)
    assert "MySQL" in analysis.databases


def test_demo_trace_shape() -> None:
    calls = parse_trace((DEMO / "traces" / "otel-traces.json").read_text(encoding="utf-8"))
    assert [(call.source, call.target, call.operation) for call in calls] == [
        ("order-service", "user-service", "GET /users/1"),
        ("order-service", "http://notification-service:8000/notify", "POST /notify"),
        ("order-service", "https://payments.example.com/charge", "POST /charge"),
    ]


def test_simple_calls_and_empty_trace() -> None:
    calls = parse_trace(json.dumps({"calls": [{"from": "a", "to": "b", "operation": "ping"}]}))
    assert calls[0].source == "a"
    assert calls[0].target == "b"
    assert calls[0].operation == "ping"
    with pytest.raises(TraceRejected, match="any calls"):
        parse_trace('{"calls": []}')
    with pytest.raises(TraceRejected, match="valid JSON"):
        parse_trace("{")


def test_demo_drift() -> None:
    analysis = analyze_directory(DEMO)
    calls = parse_trace((DEMO / "traces" / "otel-traces.json").read_text(encoding="utf-8"))
    alerts = compute_drift(analysis, calls, [])
    by_key = {(alert.kind, alert.source, alert.target): alert for alert in alerts}

    unexpected = by_key[("unexpected_external", "order-service", "payments.example.com")]
    assert unexpected.severity == "high"
    assert unexpected.title == "Unexpected external connection"
    assert unexpected.description == (
        "order-service calls payments.example.com at runtime, and that target is not a service in this project."
    )

    undocumented = by_key[("undocumented_runtime", "order-service", "notification-service")]
    assert undocumented.severity == "high"
    assert undocumented.title == "Undocumented runtime connection"
    assert undocumented.description == (
        "order-service calls notification-service in the trace, and the source never does."
    )

    gateway = by_key[("unobserved_static", "api-gateway", "user-service")]
    assert gateway.severity == "medium"
    assert gateway.title == "Unobserved static dependency"
    assert gateway.description == (
        "api-gateway depends on user-service in the source, and the trace never shows that call."
    )
    mysql = by_key[("unobserved_static", "user-service", "MySQL")]
    assert mysql.description == (
        "user-service depends on MySQL in the source, and the trace never shows that call."
    )
    assert ("unobserved_static", "api-gateway", "order-service") in by_key
    assert ("unobserved_static", "order-service", "user-service") not in by_key
    assert ("undocumented_runtime", "order-service", "user-service") not in by_key
    assert ("unexpected_external", "order-service", "notification-service") not in by_key
    assert ("undocumented_runtime", "order-service", "payments.example.com") not in by_key
    assert not any(alert.kind == "missing_intended" for alert in alerts)


def test_skips_traces_directory(tmp_path: Path) -> None:
    (tmp_path / "traces").mkdir()
    (tmp_path / "traces" / "hidden.py").write_text("import os\n", encoding="utf-8")
    (tmp_path / "api").mkdir()
    (tmp_path / "api" / "main.py").write_text("x = 1\n", encoding="utf-8")
    analysis = analyze_directory(tmp_path)
    assert [record.path for record in analysis.files] == ["api/main.py"]


def test_localhost_database_external_and_cross_import(tmp_path: Path) -> None:
    pay = tmp_path / "pay"
    pay.mkdir()
    (pay / "main.py").write_text(
        'LOCAL = "http://127.0.0.1:9/nope"\n'
        'LOOP = "http://localhost:9/nope"\n'
        'DB = "postgres://db.internal/app"\n'
        'EXT = "https://billing.example/hooks/pay"\n',
        encoding="utf-8",
    )
    ledger = tmp_path / "ledger"
    ledger.mkdir()
    (ledger / "main.py").write_text('DB = "postgresql://db/app"\n', encoding="utf-8")
    left = tmp_path / "a"
    right = tmp_path / "b"
    left.mkdir()
    right.mkdir()
    (right / "models.py").write_text("class Item:\n    pass\n", encoding="utf-8")
    (left / "main.py").write_text("from ..b.models import Item\n", encoding="utf-8")

    analysis = analyze_directory(tmp_path)
    assert analysis.databases == {"PostgreSQL"}
    kinds = {(edge.kind, edge.source, edge.target) for edge in analysis.edges}
    assert ("database", "pay", "PostgreSQL") in kinds
    assert ("database", "ledger", "PostgreSQL") in kinds
    assert ("call", "pay", "external:billing.example") in kinds
    assert ("import", "a/main.py", "b/models.py") in kinds
    assert ("call", "a", "b") in kinds
    assert not any("127.0.0.1" in edge.target or edge.target.endswith("localhost") for edge in analysis.edges)


def test_typescript_index_and_library(tmp_path: Path) -> None:
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.ts").write_text("export function ready() { return true; }\n", encoding="utf-8")
    (web / "main.ts").write_text('import "./index";\nimport "react";\n', encoding="utf-8")
    analysis = analyze_directory(tmp_path)
    main = next(record for record in analysis.files if record.path == "web/main.ts")
    assert main.imports == ["web/index.ts"]
    assert main.libraries == ["react"]
    index = next(record for record in analysis.files if record.path == "web/index.ts")
    assert "ready" in index.symbols


def test_database_url_normalization() -> None:
    from app.config import normalize_database_url

    assert normalize_database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("sqlite:///x.db") == "sqlite:///x.db"


def test_blank_database_url_falls_back_to_sqlite(monkeypatch) -> None:
    from app.config import Settings

    monkeypatch.setenv("DATABASE_URL", "   ")
    assert Settings().database_url.startswith("sqlite:///")

import io
import os
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="codemap-api-"))
os.environ["DATABASE_URL"] = "sqlite:///" + (_TMP / "test.db").as_posix()
os.environ["JWT_SECRET"] = "test-secret"
os.environ["UPLOAD_DIR"] = str(_TMP / "storage")

import jwt
import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.main import app
from app.models import Relationship, User
from app.services.security import hash_password, verify_password


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        yield test_client


def _auth(client: TestClient, email: str, password: str = "password123") -> dict[str, str]:
    response = client.post("/api/auth/register", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def _zip(entries: list[tuple[str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return buffer.getvalue()


def test_password_hash_round_trip() -> None:
    stored = hash_password("password123")
    salt_hex, digest_hex = stored.split("$")
    assert len(salt_hex) == 32
    assert len(digest_hex) == 64
    assert verify_password("password123", stored)
    assert not verify_password("password124", stored)


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_register_login_and_me(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401
    created = client.post(
        "/api/auth/register",
        json={"email": "  Ada@Example.com ", "password": "password123"},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert set(body) == {"token", "email"}
    assert body["email"] == "ada@example.com"
    payload = jwt.decode(body["token"], "test-secret", algorithms=["HS256"])
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == "ada@example.com").one()
        assert payload["sub"] == str(user.id)
    remaining = payload["exp"] - datetime.now(timezone.utc).timestamp()
    assert 6.5 * 86400 < remaining < 7.5 * 86400

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json() == {"email": "ada@example.com"}

    logged = client.post(
        "/api/auth/login",
        json={"email": "Ada@Example.com", "password": "password123"},
    )
    assert logged.status_code == 200
    assert logged.json()["email"] == "ada@example.com"

    wrong = client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "wrong-password"},
    )
    assert wrong.status_code == 401
    assert wrong.json() == {"detail": "Email or password is wrong"}

    duplicate = client.post(
        "/api/auth/register",
        json={"email": "ada@example.com", "password": "password123"},
    )
    assert duplicate.status_code == 400
    assert isinstance(duplicate.json()["detail"], str)

    invalid = client.post(
        "/api/auth/register",
        json={"email": "not-an-email", "password": "password123"},
    )
    assert invalid.status_code == 400
    short = client.post("/api/auth/register", json={"email": "short@example.com", "password": "short"})
    assert short.status_code == 400


def test_demo_contract_isolation_and_bad_zip(client: TestClient) -> None:
    owner = _auth(client, "owner@example.com")
    demo = client.post("/api/demo", headers=owner)
    assert demo.status_code == 200, demo.text
    snap = demo.json()
    project_id = snap["project"]["id"]

    assert set(snap) == {
        "project",
        "view",
        "stats",
        "severities",
        "nodes",
        "edges",
        "files",
        "alerts",
        "intents",
        "activity",
    }
    assert set(snap["project"]) == {"id", "name", "description", "trace_name", "source_name"}
    assert snap["project"]["name"] == "Demo microservices"
    assert snap["project"]["description"] == "The order service calls notifications only at runtime."
    assert snap["project"]["trace_name"] == "otel-traces.json"
    assert snap["project"]["source_name"] == "demo-microservices-app"
    assert snap["view"] == "combined"
    assert set(snap["stats"]) == {"components", "static_links", "runtime_calls", "open_alerts"}
    assert set(snap["severities"]) == {"high", "medium", "low"}
    assert snap["stats"]["static_links"] == 4
    assert snap["stats"]["runtime_calls"] == 3
    assert snap["stats"]["open_alerts"] == 5
    assert snap["severities"] == {"high": 2, "medium": 3, "low": 0}
    assert len(snap["files"]) == 8
    kinds = {node["kind"] for node in snap["nodes"]}
    assert {"service", "database", "external"}.issubset(kinds)
    assert "api" in kinds
    assert any(node["label"] == "api-gateway" for node in snap["nodes"])
    assert any(node["label"] == "payments.example.com" for node in snap["nodes"])
    assert len(snap["edges"]) >= 7
    assert snap["intents"] == []

    high = {(item["kind"], item["source"], item["target"]) for item in snap["alerts"] if item["severity"] == "high"}
    assert high == {
        ("undocumented_runtime", "order-service", "notification-service"),
        ("unexpected_external", "order-service", "payments.example.com"),
    }
    unobserved = {(item["source"], item["target"]) for item in snap["alerts"] if item["kind"] == "unobserved_static"}
    assert unobserved == {
        ("api-gateway", "user-service"),
        ("api-gateway", "order-service"),
        ("user-service", "MySQL"),
    }
    assert all(item["status"] == "open" for item in snap["alerts"])
    assert set(snap["alerts"][0]) == {
        "id",
        "severity",
        "kind",
        "title",
        "source",
        "target",
        "description",
        "status",
    }

    labels = {node["label"] for node in snap["nodes"]}
    assert {
        "api-gateway",
        "user-service",
        "order-service",
        "notification-service",
        "MySQL",
        "payments.example.com",
    }.issubset(labels)
    assert {node["label"] for node in snap["nodes"] if node["warn"]} == {
        "order-service",
        "notification-service",
        "payments.example.com",
    }
    for node in snap["nodes"]:
        assert {"id", "label", "kind", "warn", "width"}.issubset(set(node))
        assert node["kind"] in {"service", "database", "external", "api"}
        assert isinstance(node["width"], int)
        assert 96 <= node["width"] <= 180
    external = next(node for node in snap["nodes"] if node["label"] == "payments.example.com")
    assert external["id"] == "external:payments.example.com"
    assert external["kind"] == "external"

    assert all(isinstance(edge["id"], str) for edge in snap["edges"])
    assert {"call", "runtime_call", "reads"}.issubset({edge["kind"] for edge in snap["edges"]})
    static_edges = {
        (edge["source"], edge["target"])
        for edge in snap["edges"]
        if edge["origin"] == "static" and edge["kind"] in {"call", "reads"}
    }
    assert static_edges == {
        ("api-gateway", "user-service"),
        ("api-gateway", "order-service"),
        ("order-service", "user-service"),
        ("user-service", "MySQL"),
    }
    runtime_edges = {(edge["source"], edge["target"]) for edge in snap["edges"] if edge["kind"] == "runtime_call"}
    assert runtime_edges == {
        ("order-service", "user-service"),
        ("order-service", "notification-service"),
        ("order-service", "external:payments.example.com"),
    }
    gateway_user = next(
        edge
        for edge in snap["edges"]
        if edge["origin"] == "static"
        and edge["kind"] == "call"
        and edge["source"] == "api-gateway"
        and edge["target"] == "user-service"
    )
    assert gateway_user["label"] == "/users"
    assert {"id", "source", "target", "kind", "label", "origin", "source_name", "target_name"}.issubset(set(gateway_user))

    user_main = next(item for item in snap["files"] if item["path"] == "user-service/main.py")
    assert set(user_main) == {"path", "service", "symbols", "routes", "libraries", "imports"}
    assert user_main["service"] == "user-service"
    assert "user-service/models.py" in user_main["imports"]
    assert "GET /users" in user_main["routes"]
    assert "fastapi" in user_main["libraries"]
    client_ts = next(item for item in snap["files"] if item["path"] == "api-gateway/client.ts")
    assert "api-gateway/format.ts" in client_ts["imports"]
    models = next(item for item in snap["files"] if item["path"] == "user-service/models.py")
    assert "User" in models["symbols"]
    assert all(not item["path"].startswith("traces/") for item in snap["files"])
    assert snap["stats"]["components"] >= len(snap["files"]) + len([n for n in snap["nodes"] if n["kind"] != "api"])

    assert any(item["action"] == "demo" for item in snap["activity"])
    assert set(snap["activity"][0]) == {"action", "detail", "created_at"}

    with SessionLocal() as db:
        rows = db.query(Relationship).filter_by(project_id=project_id, kind="import").all()
        stored = {(row.source_key, row.target_key) for row in rows}
    assert ("user-service/main.py", "user-service/models.py") in stored
    assert ("api-gateway/client.ts", "api-gateway/format.ts") in stored

    report = client.get(f"/api/projects/{project_id}/report", headers=owner)
    assert report.status_code == 200
    report_body = report.json()
    assert set(report_body) == {
        "project",
        "stats",
        "severities",
        "alerts",
        "static_pairs",
        "runtime_pairs",
        "intents",
        "activity",
    }
    static_pairs = {(item["source"], item["target"]) for item in report_body["static_pairs"]}
    assert ("user-service", "MySQL") in static_pairs
    assert ("order-service", "notification-service") not in static_pairs
    runtime_pairs = {(item["source"], item["target"]) for item in report_body["runtime_pairs"]}
    assert ("order-service", "payments.example.com") in runtime_pairs

    listing = client.get("/api/projects", headers=owner)
    assert listing.status_code == 200
    assert listing.json()[0]["id"] == project_id
    assert listing.json()[0]["name"] == "Demo microservices"
    assert listing.json()[0]["open_alerts"] == 5
    assert listing.json()[0]["component_count"] == len([n for n in snap["nodes"] if n["kind"] != "file"])
    assert listing.json()[0]["high_alerts"] == 2
    assert listing.json()[0]["trace_name"] == "otel-traces.json"
    assert set(listing.json()[0]) == {
        "id",
        "name",
        "description",
        "open_alerts",
        "high_alerts",
        "component_count",
        "source_name",
        "trace_name",
        "created_at",
    }

    static_view = client.get(f"/api/projects/{project_id}", headers=owner, params={"view": "static"})
    assert static_view.status_code == 200
    static_body = static_view.json()
    assert static_body["view"] == "static"
    assert {node["kind"] for node in static_body["nodes"]} == {"service", "database", "api"}
    assert "payments.example.com" not in {node["label"] for node in static_body["nodes"]}
    assert all(edge["origin"] == "static" for edge in static_body["edges"])
    assert {edge["kind"] for edge in static_body["edges"]}.issubset({"call", "reads", "exposes"})

    runtime_view = client.get(f"/api/projects/{project_id}", headers=owner, params={"view": "runtime"})
    runtime_body = runtime_view.json()
    assert runtime_body["view"] == "runtime"
    assert {node["label"] for node in runtime_body["nodes"]} == {
        "order-service",
        "user-service",
        "notification-service",
        "payments.example.com",
    }
    assert all(edge["kind"] == "runtime_call" for edge in runtime_body["edges"])

    intended = client.get(f"/api/projects/{project_id}", headers=owner, params={"view": "intended"})
    assert intended.json()["nodes"] == []
    assert intended.json()["edges"] == []

    blank = client.post(
        f"/api/projects/{project_id}/intents",
        headers=owner,
        json={"source": "  ", "target": "notification-service"},
    )
    assert blank.status_code == 400
    same = client.post(
        f"/api/projects/{project_id}/intents",
        headers=owner,
        json={"source": "api-gateway", "target": "api-gateway"},
    )
    assert same.status_code == 400

    alert_id = next(item["id"] for item in snap["alerts"] if item["kind"] == "unexpected_external")
    patched = client.patch(
        f"/api/projects/{project_id}/alerts/{alert_id}",
        headers=owner,
        json={"status": "dismissed"},
    )
    assert patched.status_code == 200, patched.text
    dismissed = next(item for item in patched.json()["alerts"] if item["id"] == alert_id)
    assert dismissed["status"] == "dismissed"
    assert patched.json()["stats"]["open_alerts"] == 4
    bad_status = client.patch(
        f"/api/projects/{project_id}/alerts/{alert_id}",
        headers=owner,
        json={"status": "closed"},
    )
    assert bad_status.status_code == 400

    added = client.post(
        f"/api/projects/{project_id}/intents",
        headers=owner,
        json={"source": "order-service", "target": "brand-new"},
    )
    assert added.status_code == 200, added.text
    added_body = added.json()
    assert any(item["source"] == "order-service" and item["target"] == "brand-new" for item in added_body["intents"])
    assert any(
        item["kind"] == "missing_intended" and item["source"] == "order-service" and item["target"] == "brand-new"
        for item in added_body["alerts"]
    )
    assert next(item["status"] for item in added_body["alerts"] if item["kind"] == "unexpected_external") == "dismissed"
    duplicate = client.post(
        f"/api/projects/{project_id}/intents",
        headers=owner,
        json={"source": "order-service", "target": "brand-new"},
    )
    assert duplicate.status_code == 400

    intended_after = client.get(f"/api/projects/{project_id}", headers=owner, params={"view": "intended"})
    intended_nodes = {node["label"]: node for node in intended_after.json()["nodes"]}
    assert intended_nodes["brand-new"]["kind"] == "service"
    assert any(edge["kind"] == "intended" for edge in intended_after.json()["edges"])

    intent_id = next(item["id"] for item in added_body["intents"] if item["target"] == "brand-new")
    removed = client.delete(f"/api/projects/{project_id}/intents/{intent_id}", headers=owner)
    assert removed.status_code == 200, removed.text
    assert all(item["target"] != "brand-new" for item in removed.json()["intents"])
    assert next(item["status"] for item in removed.json()["alerts"] if item["kind"] == "unexpected_external") == "dismissed"

    other = _auth(client, "other@example.com")
    denied = client.get(f"/api/projects/{project_id}", headers=other)
    assert denied.status_code == 404
    assert denied.json() == {"detail": "Project not found"}
    other_list = client.get("/api/projects", headers=other)
    assert all(item["id"] != project_id for item in other_list.json())

    rejected = client.post(
        f"/api/projects/{project_id}/source",
        headers=owner,
        files={"file": ("evil.zip", _zip([("../evil.py", b"print(1)\n")]), "application/zip")},
    )
    assert rejected.status_code == 400
    assert isinstance(rejected.json()["detail"], str)
    kept = client.get(f"/api/projects/{project_id}", headers=owner)
    assert kept.status_code == 200
    assert any(item["path"] == "user-service/main.py" for item in kept.json()["files"])
    assert any(item["kind"] == "unexpected_external" for item in kept.json()["alerts"])


def test_project_name_rules_and_valid_zip(client: TestClient) -> None:
    headers = _auth(client, "zip@example.com")
    blank = client.post("/api/projects", headers=headers, json={"name": "   ", "description": ""})
    assert blank.status_code == 400
    long_name = "n" * 81
    too_long = client.post("/api/projects", headers=headers, json={"name": long_name, "description": "x"})
    assert too_long.status_code == 400

    created = client.post("/api/projects", headers=headers, json={"name": "Zip me", "description": "temp"})
    assert created.status_code == 200, created.text
    project_id = created.json()["project"]["id"]
    uploaded = client.post(
        f"/api/projects/{project_id}/source",
        headers=headers,
        files={"file": ("billing.zip", _zip([("billing/main.py", b"value = 1\n")]), "application/zip")},
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["project"]["source_name"] == "billing.zip"
    assert any(item["path"] == "billing/main.py" for item in uploaded.json()["files"])

    renamed = client.patch(f"/api/projects/{project_id}", headers=headers, json={"name": "  Billing  "})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["project"]["name"] == "Billing"
    assert renamed.json()["project"]["description"] == "temp"
    blank_rename = client.patch(f"/api/projects/{project_id}", headers=headers, json={"name": " "})
    assert blank_rename.status_code == 400
    other = _auth(client, "zip-other@example.com")
    foreign = client.patch(f"/api/projects/{project_id}", headers=other, json={"name": "Mine"})
    assert foreign.status_code == 404

    deleted = client.delete(f"/api/projects/{project_id}", headers=headers)
    assert deleted.status_code == 204
    assert deleted.content == b""
    missing = client.get(f"/api/projects/{project_id}", headers=headers)
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Project not found"

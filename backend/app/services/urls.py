import re

DB_LABELS = {
    "mysql": "MySQL",
    "postgresql": "PostgreSQL",
    "postgres": "PostgreSQL",
    "mongodb": "MongoDB",
}

LOCAL_HOSTS = {"localhost", "127.0.0.1"}

_DB = re.compile(r"(mysql|postgresql|postgres|mongodb)://", re.IGNORECASE)
_HTTP = re.compile(
    r"https?://([A-Za-z0-9._-]+)(?::\d+)?(/[^ \t\r\n\"'<>]*)?",
    re.IGNORECASE,
)


def database_labels(text: str) -> list[str]:
    found: list[str] = []
    for match in _DB.finditer(text):
        label = DB_LABELS[match.group(1).lower()]
        if label not in found:
            found.append(label)
    return found


def http_endpoints(text: str) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for match in _HTTP.finditer(text):
        host = match.group(1)
        if host.lower() in LOCAL_HOSTS:
            continue
        path = _clean_path(match.group(2) or "/")
        item = (host, path)
        if item not in found:
            found.append(item)
    return found


def endpoint_name(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    if re.match(r"https?://", text, re.IGNORECASE):
        match = _HTTP.search(text)
        if match:
            return match.group(1)
        return text
    if re.match(r"(mysql|postgresql|postgres|mongodb)://", text, re.IGNORECASE):
        labels = database_labels(text)
        if labels:
            return labels[0]
    return text


def _clean_path(path: str) -> str:
    path = path.split("?", 1)[0].split("#", 1)[0] or "/"
    if not path.startswith("/"):
        path = "/" + path
    return path

import ast
import os
import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from app.services.urls import database_labels, http_endpoints

SKIP_DIRS = frozenset(
    {
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        "dist",
        ".git",
        "traces",
        ".pytest_cache",
    }
)
CODE_EXTENSIONS = frozenset({".py", ".pyi", ".ts", ".tsx", ".js", ".jsx"})
_SCRIPT_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
_METHODS = {"get", "post", "put", "delete", "patch"}
_SPECIFIERS = (
    re.compile(r"""\bfrom\s+['"]([^'"]+)['"]"""),
    re.compile(r"""\bimport\s+['"]([^'"]+)['"]"""),
    re.compile(r"""\brequire\(\s*['"]([^'"]+)['"]\s*\)"""),
    re.compile(r"""\bimport\(\s*['"]([^'"]+)['"]\s*\)"""),
)
_JS_SYMBOL = re.compile(r"\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\bclass\s+([A-Za-z_$][\w$]*)")


@dataclass
class FileRecord:
    path: str
    service: str
    symbols: list[str]
    routes: list[str]
    libraries: list[str]
    imports: list[str]


@dataclass
class Edge:
    source: str
    target: str
    kind: str
    origin: str
    label: str


@dataclass
class Analysis:
    files: list[FileRecord]
    services: dict[str, int]
    databases: set[str]
    externals: dict[str, str]
    edges: list[Edge]


@dataclass
class _Draft:
    record: FileRecord
    databases: list[str] = field(default_factory=list)
    https: list[tuple[str, str]] = field(default_factory=list)


class _Edges:
    def __init__(self) -> None:
        self._order: list[tuple[str, str, str, str]] = []
        self._labels: dict[tuple[str, str, str, str], list[str]] = {}

    def add(self, source: str, target: str, kind: str, origin: str, label: str) -> None:
        key = (source, target, kind, origin)
        if key not in self._labels:
            self._labels[key] = []
            self._order.append(key)
        if label and label not in self._labels[key]:
            self._labels[key].append(label)

    def items(self) -> list[Edge]:
        edges: list[Edge] = []
        for source, target, kind, origin in self._order:
            label = ", ".join(self._labels[(source, target, kind, origin)])
            edges.append(Edge(source, target, kind, origin, label))
        return edges


def empty_analysis() -> Analysis:
    return Analysis(files=[], services={}, databases=set(), externals={}, edges=[])


def service_of(relative: str) -> str:
    parts = PurePosixPath(relative).parts
    if len(parts) <= 1:
        return "app"
    return parts[0]


def analyze_directory(root: Path) -> Analysis:
    root = Path(root)
    if not root.is_dir():
        return empty_analysis()
    rel_paths = _code_files(root)
    available = set(rel_paths)
    drafts = []
    for relative in rel_paths:
        text = _read(_join(root, relative))
        if Path(relative).suffix.lower() in {".py", ".pyi"}:
            drafts.append(_parse_python(relative, text, available))
        else:
            drafts.append(_parse_script(relative, text, available))
    return _assemble(drafts)


def _code_files(root: Path) -> list[str]:
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS and not name.startswith(".")]
        for filename in filenames:
            if filename.startswith("."):
                continue
            if Path(filename).suffix.lower() not in CODE_EXTENSIONS:
                continue
            full = Path(dirpath) / filename
            if full.is_symlink():
                continue
            relative = full.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            if any(part.startswith(".") or part in SKIP_DIRS for part in parts):
                continue
            found.append(relative)
    found.sort()
    return found


def _assemble(drafts: list[_Draft]) -> Analysis:
    services: dict[str, int] = {}
    for draft in drafts:
        services[draft.record.service] = services.get(draft.record.service, 0) + 1
    known = set(services)
    edges = _Edges()
    databases: set[str] = set()
    externals: dict[str, str] = {}
    for draft in drafts:
        for imported in draft.record.imports:
            edges.add(draft.record.path, imported, "import", "static", "")
            destination = service_of(imported)
            if destination != draft.record.service:
                edges.add(draft.record.service, destination, "call", "static", imported)
        for label in draft.databases:
            databases.add(label)
            edges.add(draft.record.service, label, "database", "static", "")
        for host, path in draft.https:
            if host in known:
                edges.add(draft.record.service, host, "call", "static", path)
            else:
                key = f"external:{host}"
                externals[key] = host
                edges.add(draft.record.service, key, "call", "static", path)
    return Analysis(
        files=[draft.record for draft in drafts],
        services=services,
        databases=databases,
        externals=externals,
        edges=edges.items(),
    )


def _parse_python(relative: str, text: str, files: set[str]) -> _Draft:
    service = service_of(relative)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        databases, endpoints = _facts_from_text(text)
        record = FileRecord(relative, service, [], [], [], [])
        return _Draft(record, databases, endpoints)
    symbols: list[str] = []
    routes: list[str] = []
    libraries: list[str] = []
    imports: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            _push(symbols, node.name)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                route = _route(decorator)
                if route:
                    _push(routes, route)
        if isinstance(node, ast.Import):
            for alias in node.names:
                resolved = _find_python(alias.name.split("."), files)
                if resolved:
                    _push(imports, resolved)
                else:
                    _push(libraries, alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                for resolved in _relative_imports(relative, node, files):
                    _push(imports, resolved)
            elif node.module:
                absolute = _absolute_imports(node, files)
                if absolute:
                    for resolved in absolute:
                        _push(imports, resolved)
                else:
                    _push(libraries, node.module)
    databases, endpoints = _facts_from_values(_string_values(tree))
    record = FileRecord(relative, service, symbols, routes, libraries, imports)
    return _Draft(record, databases, endpoints)


def _parse_script(relative: str, text: str, files: set[str]) -> _Draft:
    service = service_of(relative)
    symbols = _script_symbols(text)
    libraries: list[str] = []
    imports: list[str] = []
    for specifier in _script_specifiers(text):
        if specifier.startswith("."):
            resolved = _resolve_script(relative, specifier, files)
            if resolved:
                _push(imports, resolved)
        else:
            _push(libraries, specifier)
    databases, endpoints = _facts_from_text(text)
    record = FileRecord(relative, service, symbols, [], libraries, imports)
    return _Draft(record, databases, endpoints)


def _relative_imports(relative: str, node: ast.ImportFrom, files: set[str]) -> list[str]:
    base = _directory_parts(relative)
    up = node.level - 1
    if up > len(base):
        return []
    if up:
        base = base[:-up]
    modules = [node.module] if node.module else [alias.name for alias in node.names]
    found: list[str] = []
    for module in modules:
        if not module:
            continue
        match = _find_python(base + module.split("."), files)
        if match:
            _push(found, match)
    return found


def _absolute_imports(node: ast.ImportFrom, files: set[str]) -> list[str]:
    if not node.module:
        return []
    found: list[str] = []
    direct = _find_python(node.module.split("."), files)
    if direct:
        _push(found, direct)
        return found
    for alias in node.names:
        nested = _find_python([*node.module.split("."), alias.name], files)
        if nested:
            _push(found, nested)
    return found


def _resolve_script(relative: str, specifier: str, files: set[str]) -> str | None:
    parts = _directory_parts(relative)
    for piece in specifier.split("/"):
        if piece in {"", "."}:
            continue
        if piece == "..":
            if not parts:
                return None
            parts.pop()
            continue
        parts.append(piece)
    if not parts:
        return None
    joined = "/".join(parts)
    suffix = PurePosixPath(joined).suffix.lower()
    if joined in files and suffix in CODE_EXTENSIONS:
        return joined
    for ext in _SCRIPT_EXTENSIONS:
        candidate = joined + ext
        if candidate in files:
            return candidate
    for ext in _SCRIPT_EXTENSIONS:
        candidate = f"{joined}/index{ext}"
        if candidate in files:
            return candidate
    return None


def _find_python(parts: list[str], files: set[str]) -> str | None:
    if not parts:
        return None
    stem = "/".join(parts)
    for candidate in (f"{stem}.py", f"{stem}.pyi", f"{stem}/__init__.py", f"{stem}/__init__.pyi"):
        if candidate in files:
            return candidate
    return None


def _script_specifiers(text: str) -> list[str]:
    hits: list[tuple[int, str]] = []
    for pattern in _SPECIFIERS:
        for match in pattern.finditer(text):
            hits.append((match.start(), match.group(1)))
    found: list[str] = []
    for _, specifier in sorted(hits, key=lambda item: item[0]):
        _push(found, specifier)
    return found


def _script_symbols(text: str) -> list[str]:
    found: list[str] = []
    for match in _JS_SYMBOL.finditer(text):
        name = match.group(1) or match.group(2)
        if name:
            _push(found, name)
    return found


def _route(decorator: ast.expr) -> str | None:
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, ast.Attribute) or func.attr not in _METHODS:
        return None
    path = _literal(decorator.args[0]) if decorator.args else None
    if path is None:
        for keyword in decorator.keywords:
            if keyword.arg == "path":
                path = _literal(keyword.value)
                if path is not None:
                    break
    if not path:
        return None
    return f"{func.attr.upper()} {path}"


def _literal(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _string_values(tree: ast.AST) -> list[str]:
    documented = _docstring_ids(tree)
    values: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in documented:
            values.append(node.value)
    return values


def _docstring_ids(tree: ast.AST) -> set[int]:
    found: set[int] = set()
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        first = body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            found.add(id(first.value))
    return found


def _facts_from_values(values: list[str]) -> tuple[list[str], list[tuple[str, str]]]:
    databases: list[str] = []
    endpoints: list[tuple[str, str]] = []
    for value in values:
        for label in database_labels(value):
            _push(databases, label)
        for endpoint in http_endpoints(value):
            if endpoint not in endpoints:
                endpoints.append(endpoint)
    return databases, endpoints


def _facts_from_text(text: str) -> tuple[list[str], list[tuple[str, str]]]:
    return _facts_from_values([text])


def _directory_parts(relative: str) -> list[str]:
    parent = PurePosixPath(relative).parent
    if parent.as_posix() in {".", ""}:
        return []
    return list(parent.parts)


def _push(items: list[str], value: str) -> None:
    if value and value not in items:
        items.append(value)


def _join(root: Path, relative: str) -> Path:
    return root.joinpath(*PurePosixPath(relative).parts)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")

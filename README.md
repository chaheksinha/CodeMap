# CodeMap

CodeMap builds a live architecture map from three inputs:

1. **Source** — a zip of Python or TypeScript (parsed, never executed)
2. **Runtime** — an OpenTelemetry JSON trace, or a simple `{ "calls": [...] }` list
3. **Intent** — links you expect to exist

Where those disagree, you get drift alerts: undocumented runtime calls, unexpected externals, unobserved source dependencies, and missing intended links.

## Features

- Interactive service map (source / runtime / intent / combined)
- API routes discovered from FastAPI-style decorators
- HTTP and database dependencies mined from source strings
- Absolute and relative import edges across packages
- Alert walk-through on the map
- Demo microservices and a snake-game architecture sample
- JSON report export

## Run

Node is required for the UI. The API uses the Python that `uv` installed, because a virtualenv inside this OneDrive folder is blocked by Windows application control.

API:

```powershell
$py = "$env:APPDATA\uv\python\cpython-3.14-windows-x86_64-none\python.exe"
$packages = "$env:LOCALAPPDATA\codemap-packages"
uv pip install -r backend\requirements.txt --python $py --target $packages
$env:PYTHONPATH = $packages
Set-Location backend
& $py -m uvicorn app.main:app --host 127.0.0.1 --port 8741
```

UI:

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location frontend
npm install
npm run dev
```

Open http://127.0.0.1:43123

## Try it

1. Create an account
2. **Load demo microservices**, then click **Walk** on alerts
3. Or create a blank project and upload:
   - `fixtures/snake-game.zip` as source
   - `fixtures/snake-game/traces/otel-traces.json` as the runtime trace

## Tests

```powershell
$env:PYTHONPATH = "$env:LOCALAPPDATA\codemap-packages"
Set-Location backend
& "$env:APPDATA\uv\python\cpython-3.14-windows-x86_64-none\python.exe" -m pytest -q
```

Copy `.env.example` to `.env` and set a long `JWT_SECRET` before anyone else uses this machine.

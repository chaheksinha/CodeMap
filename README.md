# CodeMap

**See where your code and your running system disagree.**

CodeMap reads a project's source code and a record of what actually ran (a runtime trace), draws both on one architecture map, and flags every place where they don't match. That mismatch is called **drift**.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/chaheksinha/CodeMap)

![CodeMap map view](docs/screenshots/map.png)

## Why it matters

The code says which services talk to each other. At runtime they sometimes do something else: they call a service no file mentions, reach a website outside the project, or never use a dependency the code declares. These gaps cause outages, security surprises and wrong documentation. CodeMap makes them visible in one picture.

## How to read the map

| On the map | Meaning |
| --- | --- |
| **Teal line** | Code and runtime agree. The code makes the call and the trace saw it. |
| **Ochre dotted line** | Only in code. The trace never saw it run, so it may be unused. |
| **Red dashed line** | Only at runtime. It ran, but no code makes the call. This is drift. |
| **Blue line** | A service reads or writes a database. |
| **Violet dotted line** | An intended link you said should exist. |
| **Box with a red or ochre outline** | Part of an open high or medium alert. |

The four views at the top show **Everything**, only **Source**, only **Runtime**, or only **Intent**.

## Try it in two minutes

1. Open the app and create an account.
2. Click **Explore the demo**. It loads a small shop with four services and one database.
3. Click **Review drift alerts**, or press **N**, to step through each problem. Each one explains what is wrong and what to do.

A guided tour starts the first time you open a map, and the **? Help** button has a full guide and glossary.

![Reviewing a drift alert](docs/screenshots/review.png)

## Map your own project

1. Click **New project**.
2. Upload your **source code as a .zip** (Python or TypeScript). Each top-level folder becomes a service. Code is parsed for structure and never executed.
3. Upload a **runtime trace as .json**: OpenTelemetry JSON, or a simple list such as `{ "calls": [{ "source": "a", "target": "b" }] }`.
4. Optionally, add **intended links** in the Intent tab. CodeMap alerts you if one is missing.

Sample files are in [`fixtures/`](fixtures): `snake-game.zip` and `snake-game/traces/otel-traces.json`.

## Supported projects

- **Multi-service systems** (each top-level folder is a service) are mapped service to service, with drift detection against a trace.
- **Single apps** (one folder, such as a game or a website) are mapped file by file: each module and which file imports which.
- Python, TypeScript and JavaScript are analysed. Images, HTML, CSS, binaries and tool folders such as `.git`, `node_modules` and `dist` are skipped automatically, so you can zip a project as-is, including zips made by Windows.

## Features

- Interactive map with a layered left-to-right layout, search, zoom and a filterable key
- Four kinds of drift detection: runtime call not in source, call leaving the project, dependency never seen at runtime, and missing intended link
- Step-by-step alert review with plain-language explanations and next steps
- Details for every service: what it calls, what calls it, its routes and source files
- Dismiss and restore alerts. Dismissed alerts stay dismissed after re-uploads.
- Report export as Markdown or JSON
- Guided tour, help guide, glossary and inline hints
- Responsive layout for desktop, tablet and phone, with collapsible panels
- Drag-and-drop uploads and keyboard shortcuts (press `?` in the app)

| Guided tour | Help guide | Phone |
| --- | --- | --- |
| ![Tour](docs/screenshots/tour.png) | ![Guide](docs/screenshots/guide.png) | ![Mobile](docs/screenshots/mobile.png) |

## Project structure

```
CodeMap/
├── backend/                 API server (Python, FastAPI)
│   ├── app/
│   │   ├── routers/         HTTP endpoints: auth, projects, uploads, alerts
│   │   └── services/        The engine: source analyzer, trace parser,
│   │                        drift detection, safe zip handling, reports
│   └── tests/               Automated tests (pytest)
├── frontend/                Web app (React, TypeScript, Cytoscape)
│   └── src/
│       ├── pages/           Login, projects list, map workspace
│       ├── components/      Map, tour and help guide, onboarding diagram
│       ├── graph.ts         Merges code and runtime edges into one line each
│       └── legend.ts        Shared colors and wording for the whole app
├── demo-projects/           The demo shop loaded by "Explore the demo"
├── fixtures/                Sample upload files (snake game)
├── Dockerfile               Builds the web app and API into one container
└── render.yaml              One-click deployment settings for Render
```

## How it works

1. **Source analysis.** The uploaded zip is unpacked safely (no path tricks, size limits) and each file is parsed, never run. CodeMap finds services, HTTP calls, database access, imports and FastAPI-style routes.
2. **Trace parsing.** The trace is read as a list of "service A called B" events.
3. **Comparison.** Source pairs and runtime pairs are compared, along with your intended links, to produce drift alerts ranked high or medium.
4. **Map.** The web app merges both sides into one line per connection, colored by whether they agree, and lays services out in call order.

## Database: SQLite or Azure Database for PostgreSQL

CodeMap runs on a local **SQLite** file by default and supports **Azure Database for PostgreSQL (Flexible Server)** for production. The database holds user accounts (with hashed passwords), projects, the components and connections found in uploaded code, runtime calls from traces, drift alerts and their dismissed state, intended links, and the activity log.

The backend reaches it through SQLAlchemy using one setting, `DATABASE_URL`:

```
postgresql://USER:PASSWORD@SERVER.postgres.database.azure.com:5432/codemap?sslmode=require
```

- Connections are encrypted (TLS is required automatically for Azure hosts).
- Each connection is checked before use and recycled every 30 minutes, because Azure closes idle connections.
- Tables are created automatically on first start.
- `GET /api/health/db` runs a real query and reports the database type, so you can confirm the connection works.

Without `DATABASE_URL`, CodeMap falls back to a local SQLite file, which is handy for development. The test suite runs against either: set `CODEMAP_TEST_DATABASE_URL` to a PostgreSQL URL to run it on PostgreSQL.

## Run locally

Requirements: Python 3.12 or newer and Node.js 20 or newer.

**API** (terminal 1):

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8741
```

**Web app** (terminal 2):

```bash
cd frontend
npm install
npm run dev
```

Then open http://127.0.0.1:43123.

**Tests:**

```bash
cd backend
pytest -q
```

Settings can be changed with environment variables (see `.env.example`): `JWT_SECRET`, `DATABASE_URL`, `UPLOAD_DIR` and `CORS_ORIGINS`. To use Azure locally, put `DATABASE_URL=...` in a `.env` file in the project root; it is ignored by git.

## Deploy

Click **Deploy to Render** above and sign in with GitHub. When asked for `DATABASE_URL`, paste your Azure PostgreSQL connection string, or leave it blank to use the built-in SQLite database. Render builds the `Dockerfile` and runs the web app and API as one service with a generated `JWT_SECRET`. With Azure, data survives restarts and redeploys; with SQLite on Render's free plan it is reset when the service restarts.

In the Azure portal, under the database server's **Networking**, allow connections from the app's outbound IP addresses (Render lists them under the service's **Connect → Outbound**).

On Render's free plan the app sleeps after 15 minutes without visitors, so the first visit takes about 30 seconds.

## Tech stack

FastAPI · SQLAlchemy · SQLite / Azure Database for PostgreSQL · PyJWT · React 19 · TypeScript · Vite · Cytoscape.js

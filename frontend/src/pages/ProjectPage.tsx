import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useAuth } from '../auth'
import { MapView, type MapHandle } from '../components/MapView'
import { describeEdge, mergeEdges, type MapEdge } from '../graph'
import { ALERT_META, COLORS, NODE_META, SEVERITY_LABEL, VIEWS, alertMeta, iconSvg, plural, relativeTime } from '../legend'
import type { AlertItem, GraphNode, Snapshot, ViewName } from '../types'
import { Dialog, Icon, Kbd, Menu, Spinner, useToast } from '../ui'

type Tab = 'drift' | 'details' | 'intent' | 'activity'
type SeverityFilter = 'all' | 'high' | 'medium'

const WIDE = '(min-width: 1080px)'

export function ProjectPage() {
  const { email, ready, logout } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const params = useParams()
  const id = params.id ?? ''
  const mapRef = useRef<MapHandle>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const traceRef = useRef<HTMLInputElement>(null)

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState<ViewName>('combined')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('drift')
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  const [panelOpen, setPanelOpen] = useState(() => {
    const stored = readPref('codemap.panel')
    return window.matchMedia(WIDE).matches && stored !== 'closed'
  })
  const [focusedAlertId, setFocusedAlertId] = useState<number | null>(null)
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [dragKind, setDragKind] = useState<'source' | 'trace' | 'unknown' | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [confirmReplace, setConfirmReplace] = useState<{ kind: 'source' | 'trace'; file: File } | null>(null)
  const [intentFrom, setIntentFrom] = useState('')
  const [intentTo, setIntentTo] = useState('')
  const dragDepth = useRef(0)

  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const onChange = () => {
      setWide(query.matches)
      if (!query.matches) setPanelOpen(false)
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (wide) writePref('codemap.panel', panelOpen ? 'open' : 'closed')
  }, [panelOpen, wide])

  const fail = useCallback(
    (err: unknown, fallback: string) => toast.error(err instanceof ApiError ? err.message : fallback),
    [toast],
  )

  useEffect(() => {
    if (!ready || !email || !id) return
    let alive = true
    setBusy((current) => current ?? 'Loading map…')
    api<Snapshot>(`/projects/${id}?view=${view}`)
      .then((next) => {
        if (!alive) return
        setSnap(next)
        setLoadError('')
      })
      .catch((err: unknown) => {
        if (!alive) return
        if (err instanceof ApiError && err.status === 404) setLoadError('This project does not exist, or it belongs to another account.')
        else setLoadError(err instanceof ApiError ? err.message : 'Could not open this project.')
      })
      .finally(() => alive && setBusy(null))
    return () => {
      alive = false
    }
  }, [email, id, ready, view])

  const openAlerts = useMemo(() => snap?.alerts.filter((alert) => alert.status === 'open') ?? [], [snap])
  const orderedAlerts = useMemo(
    () => [...openAlerts].sort((a, b) => rankSeverity(a.severity) - rankSeverity(b.severity) || a.id - b.id),
    [openAlerts],
  )
  const focusedIndex = orderedAlerts.findIndex((alert) => alert.id === focusedAlertId)
  const focusedAlert = focusedIndex >= 0 ? orderedAlerts[focusedIndex] : null

  const focusAlert = useCallback(
    (alert: AlertItem) => {
      setFocusedAlertId(alert.id)
      const target = snap?.nodes.find((node) => node.label === alert.target) ?? snap?.nodes.find((node) => node.label === alert.source)
      setSelectedId(target?.id ?? null)
      mapRef.current?.focusPair(alert.source, alert.target)
    },
    [snap],
  )

  const step = useCallback(
    (delta: number) => {
      if (orderedAlerts.length === 0) return
      const base = focusedIndex < 0 ? (delta > 0 ? -1 : 0) : focusedIndex
      const next = (base + delta + orderedAlerts.length) % orderedAlerts.length
      focusAlert(orderedAlerts[next])
    },
    [focusAlert, focusedIndex, orderedAlerts],
  )

  const clearFocus = useCallback(() => {
    setFocusedAlertId(null)
    mapRef.current?.clearFocus()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], dialog')) return
      const key = event.key
      if (key === '/') {
        event.preventDefault()
        mapRef.current?.focusSearch()
      } else if (key === 'f' || key === 'F') mapRef.current?.fit()
      else if (key === '+' || key === '=') mapRef.current?.zoomBy(1.25)
      else if (key === '-' || key === '_') mapRef.current?.zoomBy(0.8)
      else if (key === 'n' || key === 'N') step(1)
      else if (key === 'p' || key === 'P') step(-1)
      else if (['1', '2', '3', '4'].includes(key)) setView(VIEWS[Number(key) - 1].id)
      else if (key === 'Escape') {
        setSelectedId(null)
        clearFocus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clearFocus, step])

  if (ready && !email) return <Navigate to="/login" replace />

  const nodes = snap?.nodes ?? []
  const selected = nodes.find((node) => node.id === selectedId) ?? null
  const dismissed = snap?.alerts.filter((alert) => alert.status === 'dismissed') ?? []
  const hasSource = Boolean(snap?.project.source_name)
  const hasTrace = Boolean(snap?.project.trace_name)
  const viewMeta = VIEWS.find((item) => item.id === view) ?? VIEWS[0]

  function selectNode(next: string | null) {
    setSelectedId(next)
    if (next) {
      setTab('details')
      if (window.matchMedia(WIDE).matches) setPanelOpen(true)
    }
  }

  function openTab(next: Tab) {
    setTab(next)
    setPanelOpen(true)
  }

  function requestUpload(kind: 'source' | 'trace', file: File) {
    const existing = kind === 'source' ? snap?.project.source_name : snap?.project.trace_name
    if (existing) setConfirmReplace({ kind, file })
    else void upload(kind, file)
  }

  async function upload(kind: 'source' | 'trace', file: File) {
    setConfirmReplace(null)
    setBusy(kind === 'source' ? `Reading ${file.name}…` : `Matching ${file.name} against source…`)
    const body = new FormData()
    body.append('file', file)
    try {
      const next = await api<Snapshot>(`/projects/${id}/${kind}?view=${view}`, { method: 'POST', body })
      setSnap(next)
      clearFocus()
      const open = next.alerts.filter((alert) => alert.status === 'open').length
      if (kind === 'source') {
        toast.ok(`Mapped ${plural(next.files.length, 'file')} into ${plural(next.nodes.filter((node) => node.kind === 'service').length, 'service')}.`)
      } else {
        toast.ok(open > 0 ? `Trace matched. ${plural(open, 'drift alert')} to review.` : 'Trace matched. Source and runtime agree.')
        if (open > 0) openTab('drift')
      }
    } catch (err) {
      fail(err, 'Upload failed.')
    } finally {
      setBusy(null)
    }
  }

  async function setAlertStatus(alert: AlertItem, status: 'open' | 'dismissed', quiet = false) {
    try {
      const next = await api<Snapshot>(`/projects/${id}/alerts/${alert.id}?view=${view}`, { method: 'PATCH', json: { status } })
      setSnap(next)
      if (status === 'dismissed') {
        if (focusedAlertId === alert.id) clearFocus()
        if (!quiet) toast.ok('Alert dismissed.', { label: 'Undo', run: () => void setAlertStatus(alert, 'open', true) })
      } else if (!quiet) toast.ok('Alert restored.')
    } catch (err) {
      fail(err, 'Could not update the alert.')
    }
  }

  async function addIntent(event: FormEvent) {
    event.preventDefault()
    const from = intentFrom.trim()
    const to = intentTo.trim()
    if (from === to) {
      toast.error('Pick two different parts.')
      return
    }
    setBusy('Adding intended link…')
    try {
      const next = await api<Snapshot>(`/projects/${id}/intents?view=${view}`, { method: 'POST', json: { source: from, target: to } })
      setSnap(next)
      setIntentTo('')
      const missing = next.alerts.some((alert) => alert.kind === 'missing_intended' && alert.source === from && alert.target === to && alert.status === 'open')
      toast.ok(missing ? `Added. ${from} → ${to} is not built yet, so it is now an alert.` : `Added. ${from} → ${to} already exists.`)
    } catch (err) {
      fail(err, 'Could not add that link.')
    } finally {
      setBusy(null)
    }
  }

  async function removeIntent(intentId: number) {
    try {
      const next = await api<Snapshot>(`/projects/${id}/intents/${intentId}?view=${view}`, { method: 'DELETE' })
      setSnap(next)
      toast.ok('Intended link removed.')
    } catch (err) {
      fail(err, 'Could not remove that link.')
    }
  }

  async function saveName(event?: FormEvent) {
    event?.preventDefault()
    const name = draftName.trim()
    setRenaming(false)
    if (!snap || !name || name === snap.project.name) return
    try {
      const next = await api<Snapshot>(`/projects/${id}?view=${view}`, { method: 'PATCH', json: { name } })
      setSnap(next)
      toast.ok('Project renamed.')
    } catch (err) {
      fail(err, 'Could not rename the project.')
    }
  }

  async function exportReport(format: 'json' | 'md') {
    try {
      const report = await api<Report>(`/projects/${id}/report`)
      const name = (snap?.project.name ?? `project-${id}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const text = format === 'json' ? JSON.stringify(report, null, 2) : reportMarkdown(report)
      const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `codemap-${name || id}.${format}`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.ok(`Report saved as ${link.download}.`)
    } catch (err) {
      fail(err, 'Could not export the report.')
    }
  }

  function kindOfFile(file: { name: string; type: string } | DataTransferItem): 'source' | 'trace' | 'unknown' {
    const name = 'name' in file ? file.name.toLowerCase() : ''
    const type = file.type
    if (name.endsWith('.zip') || type.includes('zip')) return 'source'
    if (name.endsWith('.json') || type.includes('json')) return 'trace'
    return 'unknown'
  }

  function onDragEnter(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    const item = event.dataTransfer.items[0]
    setDragKind(item ? kindOfFile(item) : 'unknown')
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragKind(null)
    const file = event.dataTransfer.files[0]
    if (!file) return
    const kind = kindOfFile(file)
    if (kind === 'unknown') toast.error('Drop a .zip of source code or a .json trace.')
    else requestUpload(kind, file)
  }

  /* ---------- render ---------- */

  if (loadError && !snap) {
    return (
      <main className="page-message dark">
        <Icon name="alert" size={28} />
        <h1>Could not open this map</h1>
        <p>{loadError}</p>
        <Link to="/" className="btn primary">
          Back to projects
        </Link>
      </main>
    )
  }

  const userMenu = (
    <Menu
      label="Account"
      items={[
        { kind: 'label', label: email ?? '' },
        { label: 'All projects', icon: 'grid', onSelect: () => navigate('/') },
        { kind: 'divider' },
        { label: 'Log out', icon: 'logout', onSelect: logout },
      ]}
      trigger={({ open, toggle }) => (
        <button type="button" className="avatar" aria-label="Account menu" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
          {(email ?? '?').slice(0, 1).toUpperCase()}
        </button>
      )}
    />
  )

  return (
    <div
      className="workspace"
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragKind(null)
      }}
      onDrop={onDrop}
    >
      <header className="ws-bar">
        <div className="ws-left">
          <Link to="/" className="brand" title="All projects">
            <span className="mark" aria-hidden="true" />
            <span className="brand-text">CodeMap</span>
          </Link>
          <Icon name="chevronRight" size={14} className="crumb-sep" />
          {renaming ? (
            <form className="rename" onSubmit={saveName}>
              <input
                autoFocus
                value={draftName}
                maxLength={80}
                aria-label="Project name"
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => void saveName()}
                onKeyDown={(event) => event.key === 'Escape' && setRenaming(false)}
              />
            </form>
          ) : (
            <button
              type="button"
              className="project-name"
              title="Rename project"
              disabled={!snap}
              onClick={() => {
                setDraftName(snap?.project.name ?? '')
                setRenaming(true)
              }}
            >
              <span>{snap?.project.name ?? 'Loading…'}</span>
              <Icon name="edit" size={13} />
            </button>
          )}
        </div>

        <div className="view-switch" role="radiogroup" aria-label="Map view">
          {VIEWS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={view === item.id}
              className={view === item.id ? 'on' : undefined}
              title={`${item.hint} (${index + 1})`}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="ws-right">
          <Menu
            label="Upload"
            items={[
              { label: hasSource ? 'Replace source zip' : 'Upload source zip', hint: 'Python or TypeScript, up to 8 MB', icon: 'upload', onSelect: () => zipRef.current?.click(), disabled: Boolean(busy) },
              { label: hasTrace ? 'Replace runtime trace' : 'Upload runtime trace', hint: 'OpenTelemetry JSON, up to 2 MB', icon: 'upload', onSelect: () => traceRef.current?.click(), disabled: Boolean(busy) },
            ]}
            trigger={({ open, toggle }) => (
              <button type="button" className="btn ghost-dark" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                <Icon name="upload" />
                <span className="hide-sm">Upload</span>
              </button>
            )}
          />
          <Menu
            label="Export"
            items={[
              { label: 'Report as Markdown', hint: 'For docs, tickets and reviews', icon: 'download', onSelect: () => void exportReport('md') },
              { label: 'Report as JSON', hint: 'For scripts and CI', icon: 'download', onSelect: () => void exportReport('json') },
            ]}
            trigger={({ open, toggle }) => (
              <button type="button" className="btn ghost-dark" aria-expanded={open} aria-haspopup="menu" onClick={toggle} disabled={!snap}>
                <Icon name="download" />
                <span className="hide-sm">Export</span>
              </button>
            )}
          />
          <button
            type="button"
            className={panelOpen ? 'btn ghost-dark on narrow-only' : 'btn ghost-dark narrow-only'}
            aria-pressed={panelOpen}
            title={panelOpen ? 'Hide side panel' : 'Show side panel'}
            onClick={() => setPanelOpen((open) => !open)}
          >
            <Icon name="panel" />
            {openAlerts.length > 0 && !panelOpen ? <span className="count-badge">{openAlerts.length}</span> : null}
          </button>
          {userMenu}
        </div>
        <input
          ref={zipRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) requestUpload('source', file)
            event.target.value = ''
          }}
        />
        <input
          ref={traceRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) requestUpload('trace', file)
            event.target.value = ''
          }}
        />
      </header>

      <div className={panelOpen && snap ? 'ws-body with-panel' : wide && snap ? 'ws-body with-rail' : 'ws-body'}>
        <section className={focusedAlert ? "canvas reviewing" : "canvas"} aria-label="Map">
          {!snap ? (
            <div className="canvas-loading">
              <Spinner label="Opening map…" />
            </div>
          ) : !hasSource && !hasTrace && snap.intents.length === 0 ? (
            <Onboarding
              busy={Boolean(busy)}
              onSource={() => zipRef.current?.click()}
              onTrace={() => traceRef.current?.click()}
            />
          ) : (
            <>
              {nodes.length > 0 ? (
                <MapView
                  ref={mapRef}
                  nodes={nodes}
                  edges={snap.edges}
                  alerts={snap.alerts}
                  view={view}
                  hasTrace={hasTrace}
                  selectedId={selectedId}
                  onSelect={selectNode}
                  onBackground={() => setFocusedAlertId(null)}
                  hudTopLeft={
                    <StatusCard
                      snap={snap}
                      viewHint={viewMeta.hint}
                      onSource={() => zipRef.current?.click()}
                      onTrace={() => traceRef.current?.click()}
                    />
                  }
                  hudTopCenter={
                    busy ? (
                      <div className="busy-pill">
                        <Spinner label={busy} />
                      </div>
                    ) : null
                  }
                  hudBottomCenter={
                    focusedAlert ? (
                      <AlertNavigator
                        alert={focusedAlert}
                        index={focusedIndex}
                        total={orderedAlerts.length}
                        onPrev={() => step(-1)}
                        onNext={() => step(1)}
                        onDismiss={() => void setAlertStatus(focusedAlert, 'dismissed')}
                        onClose={clearFocus}
                      />
                    ) : openAlerts.length > 0 ? (
                      <button type="button" className="review-cta" onClick={() => step(1)}>
                        <span className="pulse" aria-hidden="true" />
                        <span className="cta-text">Review {plural(openAlerts.length, 'drift alert')}</span>
                        <Kbd>N</Kbd>
                      </button>
                    ) : null
                  }
                />
              ) : (
                <div className="canvas-empty">
                  <h2>Nothing to show in the {viewMeta.label} view</h2>
                  <p>
                    {view === 'runtime'
                      ? 'Upload a runtime trace to see what actually ran.'
                      : view === 'intended'
                        ? 'Add an intended link in the Intent tab to see it here.'
                        : 'Upload a source zip with Python or TypeScript services.'}
                  </p>
                  {view === 'runtime' && !hasTrace ? (
                    <button type="button" className="btn primary" onClick={() => traceRef.current?.click()}>
                      Upload trace
                    </button>
                  ) : view === 'intended' ? (
                    <button type="button" className="btn primary" onClick={() => openTab('intent')}>
                      Add an intended link
                    </button>
                  ) : null}
                </div>
              )}

            </>
          )}

          {busy && snap && nodes.length === 0 ? (
            <div className="busy-pill standalone">
              <Spinner label={busy} />
            </div>
          ) : null}

          {dragKind ? (
            <div className={`drop-overlay ${dragKind}`}>
              <div>
                <Icon name="upload" size={28} />
                <strong>
                  {dragKind === 'source' ? 'Drop to map this source zip' : dragKind === 'trace' ? 'Drop to compare this trace' : 'Drop a .zip or .json file'}
                </strong>
                <span>{dragKind === 'unknown' ? 'Source as .zip, runtime trace as .json' : 'Nothing is executed. Files are parsed only.'}</span>
              </div>
            </div>
          ) : null}
        </section>

        {!panelOpen && wide && snap ? (
          <nav className="rail" aria-label="Side panel">
            <button type="button" className="rail-btn rail-expand" title="Expand panel" aria-label="Expand panel" onClick={() => setPanelOpen(true)}>
              <Icon name="chevronLeft" />
            </button>
            <RailButton icon="alert" label="Drift" count={openAlerts.length} tone={snap.severities.high > 0 ? 'high' : 'medium'} onClick={() => openTab('drift')} />
            <RailButton icon="node" label="Details" onClick={() => openTab('details')} />
            <RailButton icon="link" label="Intent" count={snap.intents.length} onClick={() => openTab('intent')} />
            <RailButton icon="clock" label="Activity" onClick={() => openTab('activity')} />
          </nav>
        ) : null}

        {panelOpen && snap ? (
          <>
            <button type="button" className="panel-scrim" aria-label="Close panel" onClick={() => setPanelOpen(false)} />
            <aside className="panel" aria-label="Project details">
              <div className="panel-tabs" role="tablist" aria-label="Panel">
                <TabButton id="drift" tab={tab} onClick={setTab} label="Drift" count={openAlerts.length} tone={snap.severities.high > 0 ? 'high' : 'medium'} />
                <TabButton id="details" tab={tab} onClick={setTab} label="Details" />
                <TabButton id="intent" tab={tab} onClick={setTab} label="Intent" count={snap.intents.length} />
                <TabButton id="activity" tab={tab} onClick={setTab} label="Activity" />
                <button
                  type="button"
                  className="icon-btn panel-close"
                  aria-label={wide ? 'Collapse panel' : 'Close panel'}
                  title={wide ? 'Collapse panel' : 'Close panel'}
                  onClick={() => setPanelOpen(false)}
                >
                  <Icon name={wide ? 'chevronRight' : 'close'} />
                </button>
              </div>
              <div className="panel-body" role="tabpanel">
                {tab === 'drift' ? (
                  <DriftTab
                    snap={snap}
                    alerts={orderedAlerts}
                    dismissed={dismissed}
                    severity={severity}
                    focusedId={focusedAlertId}
                    onSeverity={setSeverity}
                    onFocus={focusAlert}
                    onStatus={(alert, status) => void setAlertStatus(alert, status)}
                    onTrace={() => traceRef.current?.click()}
                  />
                ) : null}
                {tab === 'details' ? (
                  <DetailsTab
                    snap={snap}
                    selected={selected}
                    onSelect={(nodeId) => {
                      setSelectedId(nodeId)
                      mapRef.current?.centerOn(nodeId)
                    }}
                    onAlert={focusAlert}
                    onIntent={(from) => {
                      setIntentFrom(from)
                      openTab('intent')
                    }}
                  />
                ) : null}
                {tab === 'intent' ? (
                  <IntentTab
                    snap={snap}
                    from={intentFrom}
                    to={intentTo}
                    busy={Boolean(busy)}
                    onFrom={setIntentFrom}
                    onTo={setIntentTo}
                    onSubmit={addIntent}
                    onRemove={(intentId) => void removeIntent(intentId)}
                    onShow={() => setView('intended')}
                  />
                ) : null}
                {tab === 'activity' ? <ActivityTab snap={snap} /> : null}
              </div>
            </aside>
          </>
        ) : null}
      </div>

      <Dialog
        open={confirmReplace !== null}
        title={confirmReplace?.kind === 'source' ? 'Replace the source?' : 'Replace the trace?'}
        onClose={() => setConfirmReplace(null)}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setConfirmReplace(null)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => confirmReplace && void upload(confirmReplace.kind, confirmReplace.file)}>
              Replace and re-map
            </button>
          </>
        }
      >
        <p>
          <strong>{confirmReplace?.file.name}</strong> will replace{' '}
          <strong>{confirmReplace?.kind === 'source' ? snap?.project.source_name : snap?.project.trace_name}</strong>. The map and alerts are rebuilt.
          Dismissed alerts stay dismissed if they come back.
        </p>
      </Dialog>
    </div>
  )
}

/* ---------- pieces ---------- */

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the preference is simply not remembered.
  }
}

function RailButton({
  icon,
  label,
  count,
  tone,
  onClick,
}: {
  icon: 'alert' | 'node' | 'link' | 'clock'
  label: string
  count?: number
  tone?: string
  onClick: () => void
}) {
  return (
    <button type="button" className="rail-btn" title={label} aria-label={count ? `${label}, ${count}` : label} onClick={onClick}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {count ? <span className={`rail-count ${tone ?? ''}`}>{count}</span> : null}
    </button>
  )
}

function rankSeverity(value: AlertItem['severity']) {
  return value === 'high' ? 0 : value === 'medium' ? 1 : 2
}

function TabButton({ id, tab, onClick, label, count, tone }: { id: Tab; tab: Tab; onClick: (tab: Tab) => void; label: string; count?: number; tone?: string }) {
  return (
    <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : undefined} onClick={() => onClick(id)}>
      {label}
      {count ? <span className={`tab-count ${tone ?? ''}`}>{count}</span> : null}
    </button>
  )
}

function Onboarding({ busy, onSource, onTrace }: { busy: boolean; onSource: () => void; onTrace: () => void }) {
  return (
    <div className="onboarding">
      <p className="eyebrow">New map</p>
      <h2>Map this system in two uploads</h2>
      <p className="sub">CodeMap reads your code, compares it with a trace of what really ran, and flags where they disagree.</p>
      <ol className="steps">
        <li>
          <span className="step-num">1</span>
          <div>
            <strong>Upload the source</strong>
            <p>A .zip of Python or TypeScript. Each top-level folder becomes a service. Code is parsed, never run.</p>
            <button type="button" className="btn primary" disabled={busy} onClick={onSource}>
              <Icon name="upload" /> Choose source zip
            </button>
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div>
            <strong>Upload a runtime trace</strong>
            <p>OpenTelemetry JSON, or a simple <code>{'{ "calls": [...] }'}</code> list of who called whom.</p>
            <button type="button" className="btn secondary-dark" disabled={busy} onClick={onTrace}>
              <Icon name="upload" /> Choose trace
            </button>
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Review drift</strong>
            <p>Step through each place where the code and the trace disagree, then fix or dismiss it.</p>
          </div>
        </li>
      </ol>
      <p className="drop-hint">
        <Icon name="upload" size={14} /> Or drop a file anywhere on this screen.
      </p>
    </div>
  )
}

function StatusCard({ snap, viewHint, onSource, onTrace }: { snap: Snapshot; viewHint: string; onSource: () => void; onTrace: () => void }) {
  const [open, setOpen] = useState(() => {
    const stored = readPref('codemap.summary')
    return stored ? stored === 'open' : window.matchMedia('(min-width: 1280px)').matches
  })
  const services = snap.nodes.filter((node) => node.kind === 'service').length
  const missingInput = !snap.project.source_name || !snap.project.trace_name
  function toggle() {
    const next = !open
    writePref('codemap.summary', next ? 'open' : 'closed')
    setOpen(next)
  }
  return (
    <div className={open ? 'status-card open' : 'status-card'}>
      <button type="button" className="status-head" aria-expanded={open} title={open ? 'Hide inputs' : 'Show inputs and what this view shows'} onClick={toggle}>
        <span className="status-stats">
          <span>
            <small>Services</small>
            <b>{services}</b>
          </span>
          <span>
            <small>In code</small>
            <b>{snap.stats.static_links}</b>
          </span>
          <span>
            <small>Runtime</small>
            <b>{snap.stats.runtime_calls}</b>
          </span>
          <span>
            <small>Drift</small>
            <b className={snap.stats.open_alerts > 0 ? 'bad' : 'good'}>{snap.stats.open_alerts}</b>
          </span>
        </span>
        {missingInput && !open ? <span className="status-dot" aria-label="An input is missing" /> : null}
        <Icon name="chevronDown" size={14} className="status-chevron" />
      </button>
      {open ? (
        <div className="status-more">
          <p className="status-hint">{viewHint}</p>
          <div className="status-row">
            <span className={snap.project.source_name ? 'input ok' : 'input missing'}>
              <Icon name={snap.project.source_name ? 'check' : 'info'} size={13} />
              {snap.project.source_name ? (
                <span title={snap.project.source_name}>{snap.project.source_name}</span>
              ) : (
                <button type="button" onClick={onSource}>
                  Add source
                </button>
              )}
            </span>
            <span className={snap.project.trace_name ? 'input ok' : 'input missing'}>
              <Icon name={snap.project.trace_name ? 'check' : 'info'} size={13} />
              {snap.project.trace_name ? (
                <span title={snap.project.trace_name}>{snap.project.trace_name}</span>
              ) : (
                <button type="button" onClick={onTrace}>
                  Add trace to find drift
                </button>
              )}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function AlertNavigator({
  alert,
  index,
  total,
  onPrev,
  onNext,
  onDismiss,
  onClose,
}: {
  alert: AlertItem
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
  onDismiss: () => void
  onClose: () => void
}) {
  const meta = alertMeta(alert)
  return (
    <div className={`navigator ${alert.severity}`} role="region" aria-label="Alert walkthrough" aria-live="polite">
      <div className="nav-main">
        <span className={`sev ${alert.severity}`}>{SEVERITY_LABEL[alert.severity]}</span>
        <div className="nav-text">
          <strong>{meta.label}</strong>
          <code>
            {alert.source} → {alert.target}
          </code>
          <p>{meta.explain}</p>
          {meta.action ? <p className="nav-action">{meta.action}</p> : null}
        </div>
      </div>
      <div className="nav-controls">
        <button type="button" className="icon-btn" aria-label="Previous alert" title="Previous (P)" onClick={onPrev}>
          <Icon name="chevronLeft" />
        </button>
        <span className="nav-count">
          {index + 1} / {total}
        </span>
        <button type="button" className="icon-btn" aria-label="Next alert" title="Next (N)" onClick={onNext}>
          <Icon name="chevronRight" />
        </button>
        <button type="button" className="btn secondary small" onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className="icon-btn" aria-label="Stop reviewing" title="Stop (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  )
}

function DriftTab({
  snap,
  alerts,
  dismissed,
  severity,
  focusedId,
  onSeverity,
  onFocus,
  onStatus,
  onTrace,
}: {
  snap: Snapshot
  alerts: AlertItem[]
  dismissed: AlertItem[]
  severity: SeverityFilter
  focusedId: number | null
  onSeverity: (value: SeverityFilter) => void
  onFocus: (alert: AlertItem) => void
  onStatus: (alert: AlertItem, status: 'open' | 'dismissed') => void
  onTrace: () => void
}) {
  const [showDismissed, setShowDismissed] = useState(false)
  const shown = alerts.filter((alert) => severity === 'all' || alert.severity === severity)
  const groups = Object.keys(ALERT_META)
    .map((kind) => ({ kind, items: shown.filter((alert) => alert.kind === kind) }))
    .concat([{ kind: 'other', items: shown.filter((alert) => !ALERT_META[alert.kind]) }])
    .filter((group) => group.items.length > 0)

  if (!snap.project.trace_name && alerts.length === 0) {
    return (
      <div className="panel-empty">
        <Icon name="info" size={22} />
        <h3>No trace yet</h3>
        <p>Drift is found by comparing source with a runtime trace. Upload one to see which calls disagree.</p>
        <button type="button" className="btn primary" onClick={onTrace}>
          Upload trace
        </button>
      </div>
    )
  }

  return (
    <div className="drift">
      {alerts.length === 0 ? (
        <div className="panel-empty good">
          <Icon name="check" size={22} />
          <h3>No open drift</h3>
          <p>Every call in the trace is in the source, and every intended link exists.</p>
        </div>
      ) : (
        <>
          <div className="sev-filter" role="radiogroup" aria-label="Filter by severity">
            {(['all', 'high', 'medium'] as const).map((value) => {
              const count = value === 'all' ? alerts.length : snap.severities[value]
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={severity === value}
                  className={severity === value ? `on ${value}` : value}
                  disabled={value !== 'all' && count === 0}
                  onClick={() => onSeverity(value)}
                >
                  {value === 'all' ? 'All' : SEVERITY_LABEL[value]} <b>{count}</b>
                </button>
              )
            })}
          </div>
          {groups.map((group) => {
            const meta = ALERT_META[group.kind]
            return (
              <section key={group.kind} className="alert-group">
                <header>
                  <h3>{meta?.label ?? 'Other'}</h3>
                  <span>{group.items.length}</span>
                </header>
                {meta ? <p className="group-explain">{meta.explain}</p> : null}
                <ul>
                  {group.items.map((alert) => (
                    <li key={alert.id} className={`alert-card ${alert.severity} ${focusedId === alert.id ? 'focused' : ''}`}>
                      <button type="button" className="alert-main" title="Show on map" onClick={() => onFocus(alert)}>
                        <span className={`sev-dot ${alert.severity}`} aria-label={`${SEVERITY_LABEL[alert.severity]} severity`} />
                        <code>
                          {alert.source} <Icon name="arrowRight" size={12} /> {alert.target}
                        </code>
                      </button>
                      <button type="button" className="link-btn" onClick={() => onStatus(alert, 'dismissed')}>
                        Dismiss
                      </button>
                    </li>
                  ))}
                </ul>
                {meta?.action ? (
                  <p className="group-action">
                    <strong>What to do:</strong> {meta.action}
                  </p>
                ) : null}
              </section>
            )
          })}
        </>
      )}
      {dismissed.length > 0 ? (
        <section className="dismissed">
          <button type="button" className="disclosure" aria-expanded={showDismissed} onClick={() => setShowDismissed((open) => !open)}>
            <Icon name="chevronRight" size={14} />
            {plural(dismissed.length, 'dismissed alert')}
          </button>
          {showDismissed ? (
            <ul>
              {dismissed.map((alert) => (
                <li key={alert.id}>
                  <div>
                    <small>{alertMeta(alert).short}</small>
                    <code>
                      {alert.source} → {alert.target}
                    </code>
                  </div>
                  <button type="button" className="link-btn" onClick={() => onStatus(alert, 'open')}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function DetailsTab({
  snap,
  selected,
  onSelect,
  onAlert,
  onIntent,
}: {
  snap: Snapshot
  selected: GraphNode | null
  onSelect: (id: string) => void
  onAlert: (alert: AlertItem) => void
  onIntent: (from: string) => void
}) {
  if (!selected) {
    const services = snap.nodes.filter((node) => node.kind !== 'api')
    return (
      <div className="details-none">
        <p className="muted">Click a box on the map, or pick one here.</p>
        <ul className="node-index">
          {services.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => onSelect(node.id)}>
                <img src={iconSvg(node.kind, NODE_META[node.kind]?.tint ?? COLORS.ink)} alt="" />
                <span>{node.label}</span>
                <small>{NODE_META[node.kind]?.label ?? node.kind}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const meta = NODE_META[selected.kind]
  const files = selected.kind === 'service' ? snap.files.filter((file) => file.service === selected.label) : []
  const merged = mergeEdges(snap.nodes, snap.edges)
  const outgoing = merged.filter((edge) => edge.source === selected.id && edge.channel !== 'route')
  const incoming = merged.filter((edge) => edge.target === selected.id && edge.channel !== 'route')
  const routes = merged.filter((edge) => edge.source === selected.id && edge.channel === 'route')
  const related = snap.alerts.filter((alert) => alert.status === 'open' && (alert.source === selected.label || alert.target === selected.label))
  const nameOf = (nodeId: string) => snap.nodes.find((node) => node.id === nodeId)?.label ?? nodeId.replace(/^external:/, '')

  return (
    <div className="details">
      <header className="node-head">
        <span className={`node-icon ${selected.kind}`}>
          <img src={iconSvg(selected.kind, NODE_META[selected.kind]?.tint ?? COLORS.ink)} alt="" />
        </span>
        <div>
          <p className="eyebrow">{meta?.label ?? selected.kind}</p>
          <h2>{selected.label}</h2>
          <p className="muted small">{meta?.hint}</p>
        </div>
      </header>

      {related.length > 0 ? (
        <section className="detail-block">
          <h3>Drift here</h3>
          <ul className="related-alerts">
            {related.map((alert) => (
              <li key={alert.id}>
                <button type="button" className={`related ${alert.severity}`} onClick={() => onAlert(alert)}>
                  <span className={`sev-dot ${alert.severity}`} />
                  <span>
                    <strong>{alertMeta(alert).label}</strong>
                    <code>
                      {alert.source} → {alert.target}
                    </code>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ConnectionList title="Calls out" edges={outgoing} nameOf={nameOf} other={(edge) => edge.target} onSelect={onSelect} empty="Calls nothing in this view." />
      <ConnectionList title="Called by" edges={incoming} nameOf={nameOf} other={(edge) => edge.source} onSelect={onSelect} empty="Nothing calls it in this view." />

      {routes.length > 0 ? (
        <section className="detail-block">
          <h3>Routes ({routes.length})</h3>
          <ul className="chip-list">
            {routes.map((edge) => (
              <li key={edge.id}>
                <code>{nameOf(edge.target)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {files.length > 0 ? (
        <section className="detail-block">
          <h3>Source files ({files.length})</h3>
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.path}>
                <details>
                  <summary>
                    <Icon name="file" size={14} />
                    <code>{file.path}</code>
                  </summary>
                  <dl>
                    {file.routes.length ? (
                      <>
                        <dt>Routes</dt>
                        <dd>{file.routes.join(', ')}</dd>
                      </>
                    ) : null}
                    {file.symbols.length ? (
                      <>
                        <dt>Defines</dt>
                        <dd>{file.symbols.join(', ')}</dd>
                      </>
                    ) : null}
                    {file.libraries.length ? (
                      <>
                        <dt>Uses</dt>
                        <dd>{file.libraries.join(', ')}</dd>
                      </>
                    ) : null}
                    {file.imports.length ? (
                      <>
                        <dt>Imports</dt>
                        <dd>{file.imports.join(', ')}</dd>
                      </>
                    ) : null}
                    {!file.routes.length && !file.symbols.length && !file.libraries.length && !file.imports.length ? (
                      <dd className="muted">Nothing notable found in this file.</dd>
                    ) : null}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {selected.kind !== 'api' ? (
        <button type="button" className="btn secondary full" onClick={() => onIntent(selected.label)}>
          <Icon name="link" /> Add an intended link from {selected.label}
        </button>
      ) : null}
    </div>
  )
}

function lineStyle(edge: MapEdge): { color: string; dash?: string } {
  if (edge.channel === 'intended') return { color: COLORS.intent, dash: '1 3.5' }
  if (edge.channel === 'route' || edge.channel === 'import') return { color: COLORS.route }
  if (edge.status === 'runtime') return { color: COLORS.drift, dash: '5 3' }
  if (edge.status === 'both') return { color: edge.channel === 'data' ? COLORS.reads : COLORS.agree }
  return { color: edge.channel === 'data' ? COLORS.reads : COLORS.source }
}

function ConnectionList({
  title,
  edges,
  nameOf,
  other,
  onSelect,
  empty,
}: {
  title: string
  edges: MapEdge[]
  nameOf: (id: string) => string
  other: (edge: MapEdge) => string
  onSelect: (id: string) => void
  empty: string
}) {
  return (
    <section className="detail-block">
      <h3>
        {title} {edges.length ? `(${edges.length})` : ''}
      </h3>
      {edges.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="conn-list">
          {edges.map((edge) => {
            const style = lineStyle(edge)
            const labels = Array.from(new Set(edge.parts.map((part) => part.label).filter(Boolean)))
            return (
              <li key={edge.id}>
                <button type="button" onClick={() => onSelect(other(edge))}>
                  <svg width="24" height="10" aria-hidden="true">
                    <line x1="2" y1="5" x2="22" y2="5" stroke={style.color} strokeWidth="2.6" strokeLinecap="round" strokeDasharray={style.dash} />
                  </svg>
                  <span className="conn-name">{nameOf(other(edge))}</span>
                  <span className="conn-kind">{describeEdge(edge)}</span>
                  {labels.length ? <code className="conn-label">{labels.join(', ')}</code> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function IntentTab({
  snap,
  from,
  to,
  busy,
  onFrom,
  onTo,
  onSubmit,
  onRemove,
  onShow,
}: {
  snap: Snapshot
  from: string
  to: string
  busy: boolean
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onSubmit: (event: FormEvent) => void
  onRemove: (id: number) => void
  onShow: () => void
}) {
  const parties = Array.from(new Set(snap.nodes.filter((node) => node.kind !== 'api' && node.kind !== 'file').map((node) => node.label))).sort()
  const missing = new Set(
    snap.alerts.filter((alert) => alert.kind === 'missing_intended').map((alert) => `${alert.source}>${alert.target}`),
  )
  return (
    <div className="intent">
      <p className="muted">
        Write down the links your design says should exist. CodeMap checks each one against the source and the trace, and raises an alert when one is
        missing.
      </p>
      <form className="intent-form" onSubmit={onSubmit}>
        <label>
          <span>From</span>
          <input list="intent-parties" value={from} placeholder="e.g. order-service" onChange={(event) => onFrom(event.target.value)} required />
        </label>
        <Icon name="arrowRight" className="intent-arrow" />
        <label>
          <span>To</span>
          <input list="intent-parties" value={to} placeholder="e.g. payments" onChange={(event) => onTo(event.target.value)} required />
        </label>
        <datalist id="intent-parties">
          {parties.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button type="submit" className="btn primary" disabled={busy || !from.trim() || !to.trim()}>
          Add link
        </button>
      </form>
      {snap.intents.length === 0 ? (
        <p className="panel-note">No intended links yet. Pick any two parts above. A name that is not on the map yet is fine: it shows up as missing.</p>
      ) : (
        <>
          <div className="intent-head">
            <h3>{plural(snap.intents.length, 'intended link')}</h3>
            <button type="button" className="link-btn" onClick={onShow}>
              Show on map
            </button>
          </div>
          <ul className="intent-list">
            {snap.intents.map((intent) => {
              const isMissing = missing.has(`${intent.source}>${intent.target}`)
              return (
                <li key={intent.id}>
                  <span className={isMissing ? 'intent-state missing' : 'intent-state ok'}>
                    <Icon name={isMissing ? 'alert' : 'check'} size={13} />
                    {isMissing ? 'Missing' : 'Exists'}
                  </span>
                  <code>
                    {intent.source} → {intent.target}
                  </code>
                  <button type="button" className="icon-btn small" aria-label={`Remove ${intent.source} to ${intent.target}`} onClick={() => onRemove(intent.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

const ACTION_LABEL: Record<string, string> = {
  create: 'Project created',
  demo: 'Demo loaded',
  'upload source': 'Source uploaded',
  'upload trace': 'Trace uploaded',
  'add intent': 'Intended link added',
  'delete intent': 'Intended link removed',
  rename: 'Renamed',
}

function ActivityTab({ snap }: { snap: Snapshot }) {
  if (snap.activity.length === 0) return <p className="muted">Nothing has happened here yet.</p>
  return (
    <ol className="timeline">
      {snap.activity.map((item, index) => (
        <li key={index}>
          <span className="tl-dot" aria-hidden="true" />
          <div>
            <strong>{ACTION_LABEL[item.action] ?? item.action}</strong>
            {item.detail ? <code>{item.detail}</code> : null}
            <time dateTime={item.created_at} title={new Date(item.created_at).toLocaleString()}>
              {relativeTime(item.created_at)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ---------- report ---------- */

type Report = {
  project: Snapshot['project']
  stats: Snapshot['stats']
  severities: Snapshot['severities']
  alerts: AlertItem[]
  static_pairs: { source: string; target: string }[]
  runtime_pairs: { source: string; target: string }[]
  intents: { source: string; target: string }[]
}

function reportMarkdown(report: Report): string {
  const open = report.alerts.filter((alert) => alert.status === 'open')
  const lines = [
    `# CodeMap report: ${report.project.name}`,
    '',
    `- Source: ${report.project.source_name ?? 'none'}`,
    `- Trace: ${report.project.trace_name ?? 'none'}`,
    `- Generated: ${new Date().toLocaleString()}`,
    '',
    '## Summary',
    '',
    `| Components | Links in source | Runtime calls | Open drift | High | Medium |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| ${report.stats.components} | ${report.stats.static_links} | ${report.stats.runtime_calls} | ${report.stats.open_alerts} | ${report.severities.high} | ${report.severities.medium} |`,
    '',
    '## Open drift',
    '',
  ]
  if (open.length === 0) lines.push('None.')
  for (const kind of [...Object.keys(ALERT_META), 'other']) {
    const items = open.filter((alert) => (kind === 'other' ? !ALERT_META[alert.kind] : alert.kind === kind))
    if (!items.length) continue
    const meta = ALERT_META[kind]
    lines.push(`### ${meta?.label ?? 'Other'} (${items.length})`, '')
    if (meta) lines.push(`${meta.explain} ${meta.action}`, '')
    for (const alert of items) lines.push(`- **${SEVERITY_LABEL[alert.severity]}** \`${alert.source} → ${alert.target}\``)
    lines.push('')
  }
  const dismissed = report.alerts.filter((alert) => alert.status === 'dismissed')
  if (dismissed.length) {
    lines.push('## Dismissed', '')
    for (const alert of dismissed) lines.push(`- ${alertMeta(alert).short}: \`${alert.source} → ${alert.target}\``)
    lines.push('')
  }
  lines.push('## Links in source', '')
  for (const pair of report.static_pairs) lines.push(`- \`${pair.source} → ${pair.target}\``)
  lines.push('', '## Calls at runtime', '')
  for (const pair of report.runtime_pairs) lines.push(`- \`${pair.source} → ${pair.target}\``)
  if (report.intents.length) {
    lines.push('', '## Intended links', '')
    for (const pair of report.intents) lines.push(`- \`${pair.source} → ${pair.target}\``)
  }
  return `${lines.join('\n')}\n`
}

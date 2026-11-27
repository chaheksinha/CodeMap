import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError, api, projectIdOf } from '../api'
import { useAuth } from '../auth'
import { GuideDialog, HelpMenu, PROJECTS_TOUR, Tour, markSeen, seen, type GuideTab } from '../components/Guide'
import { Shell } from '../components/Shell'
import { StoryMap } from '../components/StoryMap'
import { COLORS, plural, relativeTime } from '../legend'
import type { ProjectSummary, Snapshot } from '../types'
import { Dialog, Icon, Menu, Spinner, useToast } from '../ui'

type Sort = 'recent' | 'name' | 'drift'

export function ProjectsPage() {
  const { email, ready } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<'demo' | 'create' | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [formError, setFormError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null)
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [tourOpen, setTourOpen] = useState(false)
  const [guide, setGuide] = useState<{ open: boolean; tab: GuideTab }>({ open: false, tab: 'start' })

  const hasProjects = projects.length > 0
  useEffect(() => {
    if (!hasProjects || seen('projects-tour')) return
    const timer = window.setTimeout(() => setTourOpen(true), 700)
    return () => window.clearTimeout(timer)
  }, [hasProjects])

  useEffect(() => {
    if (!ready || !email) return
    api<ProjectSummary[]>('/projects')
      .then((rows) => {
        setProjects(rows)
        setLoadError('')
      })
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Could not load projects.'))
      .finally(() => setLoading(false))
  }, [email, ready])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const rows = needle
      ? projects.filter((project) => `${project.name} ${project.description}`.toLowerCase().includes(needle))
      : [...projects]
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name))
    if (sort === 'drift') rows.sort((a, b) => b.high_alerts - a.high_alerts || b.open_alerts - a.open_alerts)
    return rows
  }, [projects, query, sort])

  if (ready && !email) return <Navigate to="/login" replace />

  const totals = projects.reduce(
    (sum, project) => ({ open: sum.open + project.open_alerts, high: sum.high + project.high_alerts }),
    { open: 0, high: 0 },
  )

  async function loadDemo() {
    setBusy('demo')
    try {
      const snap = await api<Snapshot>('/demo', { method: 'POST' })
      navigate(`/projects/${snap.project.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load the demo.')
      setBusy(null)
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault()
    setBusy('create')
    setFormError('')
    try {
      const created = await api<Snapshot | ProjectSummary>('/projects', { method: 'POST', json: { name, description } })
      navigate(`/projects/${projectIdOf(created)}`)
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not create the project.')
      setBusy(null)
    }
  }

  async function confirmDelete() {
    const project = pendingDelete
    if (!project) return
    setPendingDelete(null)
    try {
      await api(`/projects/${project.id}`, { method: 'DELETE' })
      setProjects((current) => current.filter((item) => item.id !== project.id))
      toast.ok(`Deleted “${project.name}”.`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete that project.')
    }
  }

  async function confirmRename(event: FormEvent) {
    event.preventDefault()
    const project = renameTarget
    const next = renameValue.trim()
    if (!project || !next) return
    setRenameTarget(null)
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', json: { name: next } })
      setProjects((current) => current.map((item) => (item.id === project.id ? { ...item, name: next } : item)))
      toast.ok('Project renamed.')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not rename that project.')
    }
  }

  const empty = !loading && !loadError && projects.length === 0

  return (
    <Shell
      help={
        <HelpMenu
          onTour={hasProjects ? () => setTourOpen(true) : undefined}
          onGuide={(tab) => setGuide({ open: true, tab: tab ?? 'start' })}
        />
      }
    >
      <main className="projects">
        {loading ? (
          <div className="page-loading">
            <Spinner label="Loading your projects…" />
          </div>
        ) : loadError ? (
          <div className="page-message">
            <Icon name="alert" size={26} />
            <h1>Projects did not load</h1>
            <p>{loadError}</p>
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        ) : empty ? (
          <section className="welcome">
            <div className="welcome-copy">
              <p className="eyebrow">Welcome to CodeMap</p>
              <h1>See where your code and your running system disagree.</h1>
              <p className="lede">
                Upload source and a runtime trace. CodeMap draws both on one map and flags each call that one side has and the other does not.
              </p>
              <div className="welcome-actions">
                <button type="button" className="btn primary large" disabled={busy !== null} onClick={loadDemo}>
                  {busy === 'demo' ? <Spinner label="Loading demo…" /> : 'Explore the demo'}
                </button>
                <button type="button" className="btn secondary large" onClick={() => setCreating(true)}>
                  Map my own code
                </button>
              </div>
              <p className="fine">The demo is a small shop: four services, one database, and a call that exists only at runtime.</p>
              <button type="button" className="link-btn start-link" onClick={() => setGuide({ open: true, tab: 'start' })}>
                New here? Read how CodeMap works
              </button>
            </div>
            <StoryMap />
          </section>
        ) : (
          <div className="projects-inner">
            <header className="projects-head">
              <div>
                <h1>Projects</h1>
                <p className="muted">
                  {totals.open > 0 ? (
                    <>
                      {plural(projects.length, 'map')}, <span className="drift-total">{plural(totals.open, 'open drift alert')}</span> across them
                    </>
                  ) : (
                    `${plural(projects.length, 'map')}, no open drift`
                  )}
                </p>
              </div>
              <div className="head-actions">
                <button type="button" className="btn secondary" disabled={busy !== null} onClick={loadDemo}>
                  {busy === 'demo' ? <Spinner label="Loading…" /> : 'Add demo'}
                </button>
                <button type="button" data-tour="new-project" className="btn primary" onClick={() => setCreating(true)}>
                  <Icon name="plus" /> New project
                </button>
              </div>
            </header>

            {projects.length > 3 ? (
              <div className="list-tools">
                <label className="search-field light">
                  <Icon name="search" />
                  <input value={query} placeholder="Search projects" aria-label="Search projects" onChange={(event) => setQuery(event.target.value)} />
                </label>
                <label className="sort">
                  <span>Sort</span>
                  <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                    <option value="recent">Newest first</option>
                    <option value="drift">Most drift</option>
                    <option value="name">Name</option>
                  </select>
                </label>
              </div>
            ) : null}

            {shown.length === 0 ? <p className="muted">No project matches “{query}”.</p> : null}

            <ul className="project-grid">
              {shown.map((project) => (
                <li key={project.id} className="project-card">
                  <Link to={`/projects/${project.id}`} className="card-link" aria-label={`Open ${project.name}`}>
                    <MiniMap project={project} />
                    <div className="card-body">
                      <h2>{project.name}</h2>
                      <p className="card-desc">{project.description || 'No description'}</p>
                      <div className="card-inputs">
                        <InputChip label="Source" value={project.source_name} />
                        <InputChip label="Trace" value={project.trace_name} />
                      </div>
                    </div>
                    <footer className="card-foot">
                      <DriftBadge project={project} />
                      <span className="muted card-meta">
                        {project.component_count > 0 ? <span>{plural(project.component_count, 'part')}</span> : null}
                        <span>Created {relativeTime(project.created_at)}</span>
                      </span>
                    </footer>
                  </Link>
                  <Menu
                    label={`Actions for ${project.name}`}
                    items={[
                      {
                        label: 'Rename',
                        icon: 'edit',
                        onSelect: () => {
                          setRenameTarget(project)
                          setRenameValue(project.name)
                        },
                      },
                      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => setPendingDelete(project) },
                    ]}
                    trigger={({ open, toggle }) => (
                      <button type="button" className="icon-btn card-menu" aria-label={`Actions for ${project.name}`} aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                        <Icon name="more" />
                      </button>
                    )}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      <Tour
        steps={PROJECTS_TOUR}
        open={tourOpen}
        onClose={() => {
          setTourOpen(false)
          markSeen('projects-tour')
        }}
      />
      <GuideDialog
        open={guide.open}
        initialTab={guide.tab}
        onClose={() => setGuide((current) => ({ ...current, open: false }))}
        onTour={hasProjects ? () => setTourOpen(true) : undefined}
      />

      <Dialog
        open={creating}
        title="New project"
        onClose={() => {
          setCreating(false)
          setFormError('')
        }}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" form="create-form" className="btn primary" disabled={busy !== null || !name.trim()}>
              {busy === 'create' ? <Spinner label="Creating…" /> : 'Create and upload'}
            </button>
          </>
        }
      >
        <form id="create-form" className="form" onSubmit={createProject}>
          <label>
            <span>Name</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. Checkout platform" required />
          </label>
          <label>
            <span>
              Description <em>optional</em>
            </span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this system does" />
          </label>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <p className="muted small">
            Next you’ll upload a source zip and a runtime trace.{' '}
            <button type="button" className="link-btn inline" onClick={() => setGuide({ open: true, tab: 'start' })}>
              What are these?
            </button>
          </p>
        </form>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        title="Rename project"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setRenameTarget(null)}>
              Cancel
            </button>
            <button type="submit" form="rename-form" className="btn primary" disabled={!renameValue.trim()}>
              Save
            </button>
          </>
        }
      >
        <form id="rename-form" className="form" onSubmit={confirmRename}>
          <label>
            <span>Name</span>
            <input autoFocus value={renameValue} maxLength={80} onChange={(event) => setRenameValue(event.target.value)} required />
          </label>
        </form>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        tone="danger"
        title={`Delete “${pendingDelete?.name ?? ''}”?`}
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setPendingDelete(null)}>
              Keep it
            </button>
            <button type="button" className="btn danger" onClick={() => void confirmDelete()}>
              Delete project
            </button>
          </>
        }
      >
        <p>The map, its uploaded source, trace, alerts and intended links are removed. This cannot be undone.</p>
      </Dialog>
    </Shell>
  )
}

function InputChip({ label, value }: { label: string; value: string | null }) {
  return (
    <span className={value ? 'in-chip ok' : 'in-chip none'} title={value ?? `No ${label.toLowerCase()} yet`}>
      <Icon name={value ? 'check' : 'minus'} size={12} />
      <b>{label}</b>
      <span>{value ?? 'not added'}</span>
    </span>
  )
}

function DriftBadge({ project }: { project: ProjectSummary }) {
  if (!project.trace_name && project.open_alerts === 0) return <span className="drift-badge idle">Needs trace</span>
  if (project.open_alerts === 0) return <span className="drift-badge ok">No drift</span>
  return (
    <span className={project.high_alerts > 0 ? 'drift-badge high' : 'drift-badge medium'}>
      {project.high_alerts > 0 ? `${project.high_alerts} high, ${project.open_alerts} total` : plural(project.open_alerts, 'alert')}
    </span>
  )
}

function MiniMap({ project }: { project: ProjectSummary }) {
  const drift = project.open_alerts > 0
  const traced = Boolean(project.trace_name)
  const sourced = Boolean(project.source_name)
  return (
    <svg className="mini" viewBox="0 0 160 72" aria-hidden="true">
      {sourced ? (
        <>
          <path d="M34 36 C 58 18, 70 18, 80 20" stroke={COLORS.source} strokeWidth="2" fill="none" />
          <path d="M34 36 C 58 54, 70 54, 80 52" stroke={COLORS.source} strokeWidth="2" fill="none" />
        </>
      ) : null}
      {traced ? (
        <path d="M100 52 C 116 50, 122 40, 128 36" stroke={drift ? COLORS.drift : COLORS.runtime} strokeWidth="2.2" strokeDasharray="5 4" fill="none" />
      ) : null}
      <rect x="10" y="28" width="26" height="16" rx="4" className="mini-node" />
      <rect x="78" y="12" width="26" height="16" rx="4" className="mini-node" />
      <rect x="78" y="44" width="26" height="16" rx="4" className={drift ? 'mini-node warn' : 'mini-node'} />
      <rect x="126" y="28" width="26" height="16" rx="4" className={drift ? 'mini-node warn' : 'mini-node'} strokeDasharray={traced ? undefined : '3 3'} />
    </svg>
  )
}

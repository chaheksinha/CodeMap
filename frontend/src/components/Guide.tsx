import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ALERT_META, COLORS, iconSvg } from '../legend'
import { Dialog, Icon, Kbd, Menu, useDismiss } from '../ui'

/* ---------- preferences ---------- */

export function seen(key: string): boolean {
  try {
    return window.localStorage.getItem(`codemap.seen.${key}`) === '1'
  } catch {
    return true
  }
}

export function markSeen(key: string) {
  try {
    window.localStorage.setItem(`codemap.seen.${key}`, '1')
  } catch {
    // Storage unavailable: the tour may show again next time.
  }
}

/* ---------- guided tour ---------- */

export type TourStep = {
  /** CSS selectors tried in order; the first visible one is highlighted. Empty = centered card. */
  targets?: string[]
  title: string
  body: ReactNode
}

function findTarget(step: TourStep): HTMLElement | null {
  for (const selector of step.targets ?? []) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') return el
    }
  }
  return null
}

type Placement = { spot: DOMRect | null; card: { top: number; left: number; width: number }; sheet: boolean }

function place(target: HTMLElement | null, cardHeight: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(360, vw - 24)
  const sheet = vw < 600
  if (!target) return { spot: null, card: { top: Math.max(12, (vh - cardHeight) / 2), left: (vw - width) / 2, width }, sheet }
  const box = target.getBoundingClientRect()
  const pad = 8
  const spot = new DOMRect(
    Math.max(4, box.left - pad),
    Math.max(4, box.top - pad),
    Math.min(vw - 8, box.width + pad * 2),
    Math.min(vh - 8, box.height + pad * 2),
  )
  if (sheet) return { spot, card: { top: 0, left: 0, width: vw }, sheet }
  const gap = 14
  const clampX = (x: number) => Math.min(Math.max(12, x), vw - width - 12)
  const clampY = (y: number) => Math.min(Math.max(12, y), vh - cardHeight - 12)
  const centerX = clampX(spot.left + spot.width / 2 - width / 2)
  if (spot.bottom + gap + cardHeight <= vh - 12) return { spot, card: { top: spot.bottom + gap, left: centerX, width }, sheet }
  if (spot.top - gap - cardHeight >= 12) return { spot, card: { top: spot.top - gap - cardHeight, left: centerX, width }, sheet }
  if (spot.left - gap - width >= 12) return { spot, card: { top: clampY(spot.top), left: spot.left - gap - width, width }, sheet }
  if (spot.right + gap + width <= vw - 12) return { spot, card: { top: clampY(spot.top), left: spot.right + gap, width }, sheet }
  return { spot, card: { top: clampY(vh - cardHeight - 12), left: clampX((vw - width) / 2), width }, sheet }
}

export function Tour({ steps, open, onClose }: { steps: TourStep[]; open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const [layout, setLayout] = useState<Placement | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)

  // Only keep steps whose target exists (or that are intentionally centered).
  const [active, setActive] = useState<TourStep[]>([])
  useEffect(() => {
    if (!open) return
    setActive(steps.filter((step) => !step.targets || findTarget(step)))
    setIndex(0)
  }, [open, steps])

  const step = active[index]

  const measure = useCallback(() => {
    if (!step) return
    const target = findTarget(step)
    const height = cardRef.current?.offsetHeight ?? 220
    setLayout(place(target, height))
  }, [step])

  useLayoutEffect(() => {
    if (!open || !step) return
    const target = findTarget(step)
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
    const raf = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [measure, open, step])

  useEffect(() => {
    if (open) nextRef.current?.focus()
  }, [index, open])

  const finish = useCallback(() => {
    setLayout(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Tab') return
      event.stopImmediatePropagation()
      if (event.key === 'Escape') finish()
      else if (event.key === 'ArrowRight') setIndex((value) => Math.min(value + 1, active.length - 1))
      else if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active.length, finish, open])

  if (!open || !step) return null
  const last = index === active.length - 1
  const spot = layout?.spot

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-block" onClick={(event) => event.stopPropagation()} />
      {spot ? (
        <div className="tour-spot" style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div
        ref={cardRef}
        className={layout?.sheet ? 'tour-card sheet' : 'tour-card'}
        style={layout && !layout.sheet ? { top: layout.card.top, left: layout.card.left, width: layout.card.width } : undefined}
      >
        <div className="tour-progress" aria-hidden="true">
          {active.map((_, dot) => (
            <i key={dot} className={dot === index ? 'on' : dot < index ? 'done' : undefined} />
          ))}
        </div>
        <p className="tour-count">
          Step {index + 1} of {active.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <div className="tour-body">{step.body}</div>
        <div className="tour-actions">
          <button type="button" className="link-btn muted-link" onClick={finish}>
            {last ? 'Close' : 'Skip tour'}
          </button>
          <span className="tour-nav">
            {index > 0 ? (
              <button type="button" className="btn secondary small" onClick={() => setIndex(index - 1)}>
                Back
              </button>
            ) : null}
            <button ref={nextRef} type="button" className="btn primary small" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? 'Start exploring' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

/* ---------- tour scripts ---------- */

function Line({ color, dash, width = 3 }: { color: string; dash?: string; width?: number }) {
  return (
    <svg width="30" height="10" aria-hidden="true" className="inline-line">
      <line x1="2" y1="5" x2="28" y2="5" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  )
}

export const MAP_TOUR: TourStep[] = [
  {
    title: 'Welcome to your map',
    body: (
      <p>
        CodeMap compares two things: what your <strong>code</strong> says, and what actually <strong>ran</strong>. This short tour shows you where
        everything is. It takes about a minute.
      </p>
    ),
  },
  {
    targets: ['.cy'],
    title: 'The map',
    body: (
      <>
        <p>Each box is a part of your system: a service, a database, or an outside website. Lines are calls between them.</p>
        <p className="tour-tip">Drag to move around, scroll to zoom, and click any box to see its details.</p>
      </>
    ),
  },
  {
    targets: ['.legend'],
    title: 'What the colors mean',
    body: (
      <ul className="tour-lines">
        <li>
          <Line color={COLORS.agree} /> <span>Code and runtime agree. All good.</span>
        </li>
        <li>
          <Line color={COLORS.source} dash="2 4" /> <span>In the code, but never seen running.</span>
        </li>
        <li>
          <Line color={COLORS.drift} dash="6 4" /> <span>Ran, but the code never makes this call. This is <strong>drift</strong>.</span>
        </li>
        <li className="tour-tip">Click a row in the key to hide or show that kind of line.</li>
      </ul>
    ),
  },
  {
    targets: ['.view-switch'],
    title: 'Four ways to look',
    body: (
      <p>
        <strong>Everything</strong> compares both sides. <strong>Source</strong> shows only the code, <strong>Runtime</strong> only what ran, and{' '}
        <strong>Intent</strong> only the links you said should exist. Keys <Kbd>1</Kbd> to <Kbd>4</Kbd> switch views.
      </p>
    ),
  },
  {
    targets: ['.status-card'],
    title: 'The summary',
    body: <p>Counts for this view at a glance. Click it to see which files were uploaded and what the current view shows.</p>,
  },
  {
    targets: ['.review-cta', '.navigator'],
    title: 'Review the problems',
    body: (
      <p>
        This walks you through each drift alert one by one. The map zooms to the two parts involved and explains what to do. Press <Kbd>N</Kbd> for
        next and <Kbd>P</Kbd> for previous.
      </p>
    ),
  },
  {
    targets: ['.panel', '.rail', '[data-tour="panel-toggle"]'],
    title: 'The side panel',
    body: (
      <ul className="tour-list">
        <li>
          <strong>Drift:</strong> every problem, grouped and explained.
        </li>
        <li>
          <strong>Details:</strong> what the selected box calls and what calls it.
        </li>
        <li>
          <strong>Intent:</strong> write down links that should exist.
        </li>
        <li>
          <strong>Activity:</strong> what changed and when.
        </li>
      </ul>
    ),
  },
  {
    targets: ['.map-search'],
    title: 'Find anything',
    body: (
      <p>
        Type a name to highlight it on the map, then press Enter to jump to it. The shortcut is <Kbd>/</Kbd>.
      </p>
    ),
  },
  {
    targets: ['[data-tour="upload"]'],
    title: 'Add or replace files',
    body: <p>Upload a new source zip or runtime trace at any time. You can also drag a file onto the map. Nothing you upload is ever run.</p>,
  },
  {
    targets: ['[data-tour="help"]'],
    title: 'Help is always here',
    body: <p>Open this menu to replay the tour, read the full guide, or look up a word you don’t know.</p>,
  },
]

export const PROJECTS_TOUR: TourStep[] = [
  {
    title: 'Your projects',
    body: <p>Each project is one map of one system. Here’s a quick look around this page.</p>,
  },
  {
    targets: ['.project-card'],
    title: 'A project card',
    body: (
      <ul className="tour-list">
        <li>A tick next to Source and Trace means that file is uploaded.</li>
        <li>The colored badge shows how many problems (drift alerts) are open.</li>
        <li>Click the card to open the map. Use ⋯ to rename or delete.</li>
      </ul>
    ),
  },
  {
    targets: ['[data-tour="new-project"]'],
    title: 'Map your own code',
    body: <p>Create a project, then upload a .zip of your code and a runtime trace (.json). CodeMap builds the map for you.</p>,
  },
  {
    targets: ['[data-tour="help"]'],
    title: 'Need help?',
    body: <p>The help menu has the full guide, a glossary and this tour.</p>,
  },
]

/* ---------- full guide ---------- */

type GuideTab = 'start' | 'map' | 'drift' | 'words' | 'keys'

const GUIDE_TABS: { id: GuideTab; label: string }[] = [
  { id: 'start', label: 'Getting started' },
  { id: 'map', label: 'Reading the map' },
  { id: 'drift', label: 'Drift types' },
  { id: 'words', label: 'Glossary' },
  { id: 'keys', label: 'Shortcuts' },
]

export function GuideDialog({ open, onClose, onTour, initialTab = 'start' }: { open: boolean; onClose: () => void; onTour?: () => void; initialTab?: GuideTab }) {
  const [tab, setTab] = useState<GuideTab>(initialTab)
  useEffect(() => {
    if (open) setTab(initialTab)
  }, [initialTab, open])

  return (
    <Dialog
      open={open}
      title="How CodeMap works"
      wide
      onClose={onClose}
      footer={
        <>
          {onTour ? (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                onClose()
                onTour()
              }}
            >
              <Icon name="sparkle" /> Take the tour
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={onClose}>
            Got it
          </button>
        </>
      }
    >
      <div className="guide">
        <nav className="guide-tabs" role="tablist" aria-label="Guide sections">
          {GUIDE_TABS.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'on' : undefined} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="guide-body" role="tabpanel">
          {tab === 'start' ? <GuideStart /> : null}
          {tab === 'map' ? <GuideMap /> : null}
          {tab === 'drift' ? <GuideDrift /> : null}
          {tab === 'words' ? <GuideWords /> : null}
          {tab === 'keys' ? <GuideKeys /> : null}
        </div>
      </div>
    </Dialog>
  )
}

function GuideStart() {
  return (
    <>
      <p className="guide-lede">CodeMap finds places where your code and your running system disagree. It needs two files.</p>
      <ol className="guide-steps">
        <li>
          <span className="step-num">1</span>
          <div>
            <strong>Upload your source code as a .zip</strong>
            <p>Python or TypeScript. Each top-level folder becomes a service on the map. The code is read, never run.</p>
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div>
            <strong>Upload a runtime trace as .json</strong>
            <p>
              A record of which service called which while the system ran. OpenTelemetry JSON works, or a simple list such as{' '}
              <code>{'{ "calls": [{ "source": "a", "target": "b" }] }'}</code>.
            </p>
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Review the drift</strong>
            <p>Click Review drift alerts and step through each problem. Fix it in your code, or dismiss it if it’s expected.</p>
          </div>
        </li>
      </ol>
      <p className="guide-note">
        <Icon name="info" size={14} /> No files yet? Open the demo from the projects page to see a finished example.
      </p>
    </>
  )
}

function GuideMap() {
  const lines = [
    { color: COLORS.agree, dash: undefined, label: 'Code and runtime agree', text: 'The code makes this call and the trace saw it. Nothing to do.' },
    { color: COLORS.source, dash: '2 4', label: 'Only in code', text: 'The code makes this call, but it never happened in the trace. It may be unused.' },
    { color: COLORS.drift, dash: '6 4', label: 'Only at runtime (drift)', text: 'It happened while running, but no code makes the call. This needs a look.' },
    { color: COLORS.reads, dash: undefined, label: 'Data access', text: 'A service reads or writes a database.' },
    { color: COLORS.intent, dash: '1 4', label: 'Intended', text: 'A link you said should exist.' },
  ]
  const boxes = [
    { kind: 'service', label: 'Service', text: 'One part of your app (a top-level folder in the code).' },
    { kind: 'database', label: 'Database', text: 'Where data is stored.' },
    { kind: 'external', label: 'Outside host', text: 'A website or API that is not part of your code.' },
    { kind: 'api', label: 'Route', text: 'A web address a service answers on, like GET /users.' },
  ]
  return (
    <>
      <h3 className="guide-h">Lines</h3>
      <ul className="guide-legend">
        {lines.map((line) => (
          <li key={line.label}>
            <Line color={line.color} dash={line.dash} />
            <div>
              <strong>{line.label}</strong>
              <p>{line.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <h3 className="guide-h">Boxes</h3>
      <ul className="guide-legend">
        {boxes.map((box) => (
          <li key={box.kind}>
            <span className={`key-node ${box.kind}`}>
              <img src={iconSvg(box.kind, box.kind === 'database' ? COLORS.reads : box.kind === 'external' ? '#7A5A4E' : COLORS.ink)} alt="" />
            </span>
            <div>
              <strong>{box.label}</strong>
              <p>{box.text}</p>
            </div>
          </li>
        ))}
        <li>
          <span className="key-halo big" aria-hidden="true" />
          <div>
            <strong>Red or ochre outline</strong>
            <p>This box is part of an open problem: red for high, ochre for medium.</p>
          </div>
        </li>
      </ul>
    </>
  )
}

function GuideDrift() {
  return (
    <>
      <p className="guide-lede">“Drift” means the code and the running system tell different stories. There are four kinds.</p>
      <ul className="guide-drift">
        {Object.entries(ALERT_META).map(([kind, meta]) => (
          <li key={kind}>
            <strong>{meta.label}</strong>
            <p>{meta.explain}</p>
            <p className="guide-action">
              <b>What to do:</b> {meta.action}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}

const WORDS: [string, string][] = [
  ['Service', 'One part of your application, such as user-service. In CodeMap, each top-level folder of the zip.'],
  ['Trace', 'A recording of which service called which while the system was running.'],
  ['OpenTelemetry', 'A common, free standard for recording traces. Most monitoring tools can export it.'],
  ['Drift', 'A difference between what the code says and what actually ran.'],
  ['Intent', 'A link you expect to exist because your design says so. CodeMap checks it for you.'],
  ['Route', 'A web address a service answers on, such as POST /orders.'],
  ['Outside host', 'A website or API that is not part of your uploaded code, such as payments.example.com.'],
  ['Dismiss', 'Hide an alert you’ve checked and accept. You can restore it at any time.'],
]

function GuideWords() {
  return (
    <dl className="guide-words">
      {WORDS.map(([word, meaning]) => (
        <div key={word}>
          <dt>{word}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  )
}

function GuideKeys() {
  const keys: [ReactNode, string][] = [
    [<Kbd key="a">N</Kbd>, 'Next drift alert'],
    [<Kbd key="b">P</Kbd>, 'Previous drift alert'],
    [<><Kbd>1</Kbd> to <Kbd>4</Kbd></>, 'Switch view'],
    [<Kbd key="c">/</Kbd>, 'Find on the map'],
    [<Kbd key="d">F</Kbd>, 'Fit the map to the screen'],
    [<><Kbd>+</Kbd> <Kbd>−</Kbd></>, 'Zoom in and out'],
    [<Kbd key="e">Esc</Kbd>, 'Clear selection or stop reviewing'],
    [<Kbd key="f">?</Kbd>, 'Open this guide'],
  ]
  return (
    <dl className="guide-keys">
      {keys.map(([combo, label], index) => (
        <div key={index}>
          <dt>{combo}</dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ---------- help menu ---------- */

export function HelpMenu({ onTour, onGuide, tone = 'light' }: { onTour?: () => void; onGuide: (tab?: GuideTab) => void; tone?: 'light' | 'bar' }) {
  return (
    <Menu
      label="Help"
      items={[
        ...(onTour ? [{ label: 'Take the tour', hint: 'A one-minute walk around this screen', icon: 'sparkle' as const, onSelect: onTour }] : []),
        { label: 'How CodeMap works', hint: 'Getting started, step by step', icon: 'info', onSelect: () => onGuide('start') },
        { label: 'Reading the map', hint: 'What every color and box means', icon: 'layers', onSelect: () => onGuide('map') },
        { label: 'Drift types', hint: 'Each problem and how to fix it', icon: 'alert', onSelect: () => onGuide('drift') },
        { label: 'Glossary', hint: 'Plain meanings of the terms', icon: 'file', onSelect: () => onGuide('words') },
        { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: () => onGuide('keys') },
      ]}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          data-tour="help"
          className={tone === 'bar' ? 'btn ghost-dark help-btn' : 'help-btn light'}
          aria-label="Help"
          title="Help and guides (?)"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
        >
          <span className="help-glyph" aria-hidden="true">
            ?
          </span>
          <span className="hide-sm">Help</span>
        </button>
      )}
    />
  )
}

/* ---------- inline hint ---------- */

export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  return (
    <span className="info-tip" ref={ref}>
      <button type="button" className="info-btn" aria-label={`What is ${label}?`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="info" size={14} />
      </button>
      {open ? (
        <span className="info-pop" role="note">
          <strong>What is {label}?</strong>
          {children}
        </span>
      ) : null}
    </span>
  )
}

export type { GuideTab }

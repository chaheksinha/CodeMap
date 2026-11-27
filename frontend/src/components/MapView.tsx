import cytoscape, { type Core, type ElementDefinition, type EventObject } from 'cytoscape'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { describeEdge, mergeEdges, noteFor, type MapEdge } from '../graph'
import { ALERT_META, COLORS, NODE_META, iconSvg } from '../legend'
import type { AlertItem, GraphEdge, GraphNode, ViewName } from '../types'
import { Icon, Kbd } from '../ui'

export type MapHandle = {
  focusPair: (sourceLabel: string, targetLabel: string) => void
  clearFocus: () => void
  centerOn: (id: string) => void
  fit: () => void
  zoomBy: (factor: number) => void
  focusSearch: () => void
}

type Props = {
  nodes: GraphNode[]
  edges: GraphEdge[]
  alerts: AlertItem[]
  view: ViewName
  hasTrace: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
  onBackground?: () => void
  /** Floating content placed in the map's overlay grid, so nothing can overlap. */
  hudTopLeft?: ReactNode
  hudTopCenter?: ReactNode
  hudBottomCenter?: ReactNode
}

type Tip = { x: number; y: number; title: string; lines: string[]; tone: string }

type Toggle = {
  id: string
  label: string
  hint: string
  line?: { color: string; dash?: string; width?: number }
  icon?: string
  test: (el: { group: 'nodes' | 'edges'; kind?: string; channel?: string; status?: string }) => boolean
}

function togglesFor(view: ViewName, hasTrace: boolean): Toggle[] {
  const compare = view === 'combined' && hasTrace
  const list: Toggle[] = []
  if (compare) {
    list.push(
      { id: 'both', label: 'Code and runtime agree', hint: 'In the source and seen in the trace.', line: { color: COLORS.agree, width: 3 }, test: (el) => el.status === 'both' },
      { id: 'code', label: 'Only in code', hint: 'The source has it, the trace never showed it.', line: { color: COLORS.source, dash: '2 4', width: 2.6 }, test: (el) => el.status === 'code' },
      { id: 'runtime', label: 'Only at runtime', hint: 'The trace shows it, the source never makes it.', line: { color: COLORS.drift, dash: '6 4', width: 3 }, test: (el) => el.status === 'runtime' },
    )
  } else if (view === 'runtime') {
    list.push({ id: 'runtime', label: 'Calls at runtime', hint: 'Recorded in the trace.', line: { color: COLORS.runtime, dash: '6 4' }, test: (el) => el.status === 'runtime' || el.status === 'both' })
  } else if (view !== 'intended') {
    list.push({ id: 'code', label: 'Calls in code', hint: 'HTTP calls found in the source.', line: { color: COLORS.source }, test: (el) => el.channel === 'call' && el.status === 'code' })
  }
  if (view !== 'intended' && view !== 'runtime') {
    list.push({ id: 'data', label: 'Data access', hint: 'Reads or writes a database.', line: { color: COLORS.reads }, test: (el) => el.channel === 'data' })
  }
  if (view === 'combined' || view === 'intended') {
    list.push({ id: 'intended', label: 'Intended', hint: 'Links you said should exist.', line: { color: COLORS.intent, dash: '1 4', width: 2.6 }, test: (el) => el.channel === 'intended' })
  }
  list.push({ id: 'import', label: 'Imports (file uses file)', hint: 'One source file imports another.', line: { color: '#55636F', width: 2 }, test: (el) => el.channel === 'import' })
  list.push(
    { id: 'routes', label: 'Routes', hint: 'HTTP routes each service serves.', icon: 'api', test: (el) => el.kind === 'api' || el.channel === 'route' },
    { id: 'database', label: 'Databases', hint: 'Data stores named in the source.', icon: 'database', test: (el) => el.kind === 'database' },
    { id: 'external', label: 'Outside hosts', hint: 'Hosts outside this repository.', icon: 'external', test: (el) => el.kind === 'external' },
  )
  return list
}

/* ---------- layout: left-to-right layers, like a line map ---------- */

function sizeOf(node: GraphNode): { w: number; h: number } {
  if (node.kind === 'api') return { w: Math.max(92, Math.min(220, 34 + node.label.length * 7.2)), h: 28 }
  return { w: Math.max(140, Math.min(250, 58 + node.label.length * 8.2)), h: 46 }
}

function layout(nodes: GraphNode[], edges: MapEdge[]): Record<string, { x: number; y: number }> {
  // Services (or, in a single-app project, its modules) are arranged in call order.
  const services = nodes.filter((node) => node.kind === 'service' || node.kind === 'file')
  const serviceIds = new Set(services.map((node) => node.id))
  const rank = new Map<string, number>(services.map((node) => [node.id, 0]))
  const links = edges.filter(
    (edge) => serviceIds.has(edge.source) && serviceIds.has(edge.target) && edge.source !== edge.target && edge.channel !== 'route',
  )
  for (let pass = 0; pass < services.length; pass += 1) {
    let changed = false
    for (const edge of links) {
      const next = (rank.get(edge.source) ?? 0) + 1
      if (next > (rank.get(edge.target) ?? 0) && next < services.length) {
        rank.set(edge.target, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const maxRank = Math.max(0, ...rank.values())

  const routesOf = new Map<string, GraphNode[]>()
  const loose: GraphNode[] = []
  for (const node of nodes) {
    if (node.kind !== 'api') continue
    const parent = services.find((service) => service.label === node.service)
    if (!parent) loose.push(node)
    else routesOf.set(parent.id, [...(routesOf.get(parent.id) ?? []), node])
  }

  const columns: GraphNode[][] = Array.from({ length: maxRank + 2 }, () => [])
  for (const node of services) columns[rank.get(node.id) ?? 0].push(node)
  columns[maxRank + 1].push(...nodes.filter((node) => node.kind === 'database'), ...nodes.filter((node) => node.kind === 'external'))
  columns[0].push(...nodes.filter((node) => !['service', 'file', 'api', 'database', 'external'].includes(node.kind)), ...loose)

  const order = new Map<string, number>()
  const positions: Record<string, { x: number; y: number }> = {}
  const widest = columns.map((column) => Math.max(140, ...column.map((node) => sizeOf(node).w)))
  let x = 0
  columns.forEach((column, index) => {
    if (index > 0) {
      const score = (node: GraphNode) => {
        const callers = edges.filter((edge) => edge.target === node.id && order.has(edge.source))
        if (!callers.length) return Number.MAX_SAFE_INTEGER / 2
        return callers.reduce((sum, edge) => sum + (order.get(edge.source) ?? 0), 0) / callers.length
      }
      const group = (node: GraphNode) => (node.kind === 'external' ? 2 : node.kind === 'database' ? 1 : 0)
      column.sort((a, b) => group(a) - group(b) || score(a) - score(b) || a.label.localeCompare(b.label))
    }
    const blocks = column.map((node) => {
      const kids = routesOf.get(node.id) ?? []
      return { node, kids, height: sizeOf(node).h + (kids.length ? 12 + kids.length * 36 : 0) }
    })
    const gap = 52
    const total = blocks.reduce((sum, block) => sum + block.height, 0) + Math.max(0, blocks.length - 1) * gap
    let y = -total / 2
    const cx = x + widest[index] / 2
    for (const block of blocks) {
      const head = sizeOf(block.node).h
      positions[block.node.id] = { x: cx, y: y + head / 2 }
      order.set(block.node.id, y)
      let kidY = y + head + 12
      for (const kid of block.kids) {
        positions[kid.id] = { x: cx + 16, y: kidY + 14 }
        order.set(kid.id, kidY)
        kidY += 36
      }
      y += block.height + gap
    }
    x += widest[index] + 110
  })
  return positions
}

/* ---------- styles ---------- */

const INK = COLORS.ink

const stylesheet: cytoscape.StylesheetStyle[] = [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      width: 'data(w)',
      height: 'data(h)',
      label: 'data(label)',
      'background-color': '#FFFFFF',
      'border-width': 2,
      'border-color': INK,
      color: INK,
      'font-family': 'Overpass, Segoe UI, sans-serif',
      'font-size': 13,
      'font-weight': 700,
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-x': 10,
      'text-margin-y': 1,
      'text-wrap': 'ellipsis',
      'text-max-width': 'data(tw)',
      'background-image': 'data(icon)',
      'background-width': 16,
      'background-height': 16,
      'background-position-x': 13,
      'background-position-y': '50%',
      'background-fit': 'none',
      'background-clip': 'none',
      'underlay-color': COLORS.drift,
      'underlay-opacity': 0,
      'underlay-padding': 7,
      'underlay-shape': 'round-rectangle',
      'transition-property': 'opacity, border-color, underlay-opacity',
      'transition-duration': 200,
    },
  },
  { selector: 'node[kind = "api"]', style: { 'font-family': 'Overpass Mono, ui-monospace, monospace', 'font-size': 11, 'font-weight': 500, 'border-width': 1, 'border-color': '#AEB8C1', color: '#3C4954', 'background-width': 12, 'background-height': 12, 'background-position-x': 10, 'text-margin-x': 8 } },
  { selector: 'node[kind = "database"]', style: { 'background-color': '#E7F0FA', 'border-color': COLORS.reads, color: '#173A60' } },
  { selector: 'node[kind = "external"]', style: { 'background-color': '#F4EFEC', 'border-style': 'dashed', 'border-color': '#7A5A4E', color: '#4A3229' } },
  { selector: 'node.warn', style: { 'border-color': COLORS.drift, 'border-width': 2.5, 'underlay-opacity': 0.14 } },
  { selector: 'node.caution', style: { 'border-color': COLORS.caution, 'border-width': 2.5 } },
  { selector: 'node.picked', style: { 'border-width': 3.5, 'underlay-color': INK, 'underlay-opacity': 0.12 } },
  { selector: 'node.match', style: { 'underlay-color': COLORS.reads, 'underlay-opacity': 0.25 } },
  {
    selector: 'edge',
    style: {
      width: 2.4,
      'line-color': COLORS.source,
      'target-arrow-color': COLORS.source,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.95,
      'curve-style': 'taxi',
      'taxi-direction': 'horizontal',
      'taxi-turn': '50%',
      'taxi-turn-min-distance': 14,
      label: 'data(caption)',
      'font-family': 'Overpass, Segoe UI, sans-serif',
      'font-size': 11,
      'font-weight': 700,
      color: '#FFFFFF',
      'text-background-color': COLORS.drift,
      'text-background-opacity': 1,
      'text-background-padding': '4px',
      'text-background-shape': 'roundrectangle',
      'transition-property': 'opacity, width',
      'transition-duration': 200,
    },
  },
  { selector: 'edge[status = "both"]', style: { width: 3.4, 'line-color': COLORS.agree, 'target-arrow-color': COLORS.agree } },
  { selector: 'edge[status = "runtime"]', style: { width: 2.6, 'line-style': 'dashed', 'line-dash-pattern': [8, 6], 'line-color': COLORS.runtime, 'target-arrow-color': COLORS.runtime } },
  { selector: 'edge[channel = "data"]', style: { 'line-color': COLORS.reads, 'target-arrow-color': COLORS.reads } },
  { selector: 'edge[channel = "data"][status = "both"]', style: { width: 3.4 } },
  { selector: 'edge[channel = "intended"]', style: { width: 2.6, 'curve-style': 'unbundled-bezier', 'control-point-distances': [-60], 'control-point-weights': [0.5], 'line-style': 'dotted', 'line-color': COLORS.intent, 'target-arrow-color': COLORS.intent, 'text-background-color': COLORS.intent } },
  { selector: 'edge[channel = "route"]', style: { width: 1.2, 'line-color': COLORS.route, 'target-arrow-shape': 'none', 'taxi-direction': 'downward', 'taxi-turn': 12 } },
  { selector: 'edge[channel = "import"]', style: { width: 2, 'line-color': '#55636F', 'target-arrow-color': '#55636F' } },
  { selector: 'node[kind = "file"]', style: { 'font-family': 'Overpass Mono, ui-monospace, monospace', 'font-size': 12, 'font-weight': 600, 'border-width': 1.5 } },
  { selector: 'edge.arc', style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': 'data(bend)', 'control-point-weights': [0.5] } },
  { selector: 'edge.drift', style: { width: 3.4, 'line-color': COLORS.drift, 'target-arrow-color': COLORS.drift } },
  { selector: 'edge.stale', style: { 'line-style': 'dashed', 'line-dash-pattern': [2, 5], 'text-background-color': COLORS.source } },
  { selector: 'edge.hot', style: { width: 5, 'z-index': 99 } },
  { selector: 'edge.hover', style: { width: 4.2, 'z-index': 98 } },
  { selector: '.hidden', style: { display: 'none' } },
  { selector: '.dim', style: { opacity: 0.14 } },
]

function structureKey(nodes: GraphNode[], edges: GraphEdge[]): string {
  return `${nodes.map((node) => `${node.id}|${node.kind}`).join(',')}#${edges.map((edge) => `${edge.id}|${edge.kind}`).join(',')}`
}

/* ---------- component ---------- */

export const MapView = forwardRef<MapHandle, Props>(function MapView(
  { nodes, edges, alerts, view, hasTrace, selectedId, onSelect, onBackground, hudTopLeft, hudTopCenter, hudBottomCenter },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const cyRef = useRef<Core | null>(null)
  const onSelectRef = useRef(onSelect)
  const onBackgroundRef = useRef(onBackground)
  onSelectRef.current = onSelect
  onBackgroundRef.current = onBackground
  const focusRef = useRef<{ source: string; target: string } | null>(null)
  const hoverRef = useRef<string | null>(null)
  const matchRef = useRef<Set<string> | null>(null)
  const alertsRef = useRef(alerts)
  alertsRef.current = alerts

  const merged = useMemo(() => mergeEdges(nodes, edges), [nodes, edges])
  const mergedRef = useRef(merged)
  mergedRef.current = merged
  const key = useMemo(() => structureKey(nodes, edges), [nodes, edges])
  const toggles = useMemo(() => togglesFor(view, hasTrace), [view, hasTrace])

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [hidden, setHidden] = useState<string[]>(() => (nodes.filter((node) => node.kind === 'api').length > 10 ? ['routes'] : []))
  const [legendOpen, setLegendOpen] = useState(() => window.matchMedia('(min-width: 1180px) and (min-height: 760px)').matches)
  const [tip, setTip] = useState<Tip | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const present = useMemo(
    () =>
      toggles.filter(
        (item) =>
          nodes.some((node) => item.test({ group: 'nodes', kind: node.kind })) ||
          merged.some((edge) => item.test({ group: 'edges', channel: edge.channel, status: edge.status })),
      ),
    [merged, nodes, toggles],
  )

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return nodes
      .filter((node) => node.label.toLowerCase().includes(needle))
      .sort((a, b) => a.label.toLowerCase().indexOf(needle) - b.label.toLowerCase().indexOf(needle) || a.label.localeCompare(b.label))
      .slice(0, 8)
  }, [nodes, query])

  function emphasize() {
    const cy = cyRef.current
    if (!cy) return
    cy.batch(() => {
      cy.elements().removeClass('dim hot hover match')
      const focus = focusRef.current
      if (focus) {
        const src = cy.nodes().filter((node) => node.data('label') === focus.source)
        const tgt = cy.nodes().filter((node) => node.data('label') === focus.target)
        const link = src.edgesTo(tgt)
        if (src.nonempty() || tgt.nonempty()) {
          cy.elements().not(src.union(tgt).union(link)).addClass('dim')
          link.addClass('hot')
          return
        }
      }
      if (hoverRef.current) {
        const node = cy.getElementById(hoverRef.current)
        if (node.nonempty()) {
          const hood = node.closedNeighborhood()
          cy.elements().not(hood).addClass('dim')
          hood.edges().addClass('hover')
          return
        }
      }
      const matches = matchRef.current
      if (matches && matches.size > 0) {
        const hit = cy.nodes().filter((node) => matches.has(node.id()))
        cy.elements().not(hit).addClass('dim')
        hit.addClass('match')
      }
    })
  }

  function flyTo(eles: cytoscape.CollectionReturnValue, extra = 0) {
    const cy = cyRef.current
    if (!cy || eles.empty()) return
    const target = safeViewport(cy, eles, extra)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) cy.viewport(target)
    else cy.animate({ ...target, duration: 480, easing: 'ease-in-out-cubic' })
  }

  function visibleEles(cy: Core) {
    return cy.elements().not('.hidden')
  }

  useImperativeHandle(ref, () => ({
    focusPair(source, target) {
      focusRef.current = { source, target }
      emphasize()
      const cy = cyRef.current
      if (!cy) return
      const group = cy.nodes().filter((node) => node.data('label') === source || node.data('label') === target)
      if (group.nonempty()) flyTo(group, Math.min(120, cy.width() / 8))
    },
    clearFocus() {
      focusRef.current = null
      emphasize()
    },
    centerOn(id) {
      const cy = cyRef.current
      const node = cy?.getElementById(id)
      if (!cy || !node || node.empty()) return
      cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1), duration: 360, easing: 'ease-out-cubic' })
    },
    fit() {
      const cy = cyRef.current
      if (cy) flyTo(visibleEles(cy))
    },
    zoomBy(factor) {
      const cy = cyRef.current
      if (cy) zoomAround(cy, factor)
    },
    focusSearch() {
      searchRef.current?.focus()
      searchRef.current?.select()
    },
  }))

  // Build only when the structure changes, so alerts and filters never reset the camera.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const positions = layout(nodes, merged)
    const elements: ElementDefinition[] = [
      ...nodes.map((node) => {
        const size = sizeOf(node)
        return {
          data: {
            id: node.id,
            label: node.label,
            kind: node.kind,
            w: size.w,
            h: size.h,
            tw: `${size.w - 42}px`,
            icon: iconSvg(node.kind, NODE_META[node.kind]?.tint ?? INK),
          },
          position: positions[node.id] ?? { x: 0, y: 0 },
        }
      }),
      ...merged
        .filter((edge) => positions[edge.source] && positions[edge.target] && edge.source !== edge.target)
        .map((edge, index) => {
          const from = positions[edge.source]
          const to = positions[edge.target]
          const dx = Math.abs(to.x - from.x)
          const long = edge.channel !== 'route' && edge.channel !== 'intended' && (dx > 420 || dx < 40 || to.x < from.x)
          const bend = (index % 2 ? 1 : -1) * Math.min(170, 46 + dx * 0.09)
          return {
            data: { id: edge.id, source: edge.source, target: edge.target, channel: edge.channel, status: edge.status, caption: '', bend },
            classes: long ? 'arc' : '',
          }
        }),
    ]
    const cy = cytoscape({
      container: host,
      elements,
      style: stylesheet,
      layout: { name: 'preset', fit: false },
      minZoom: 0.2,
      maxZoom: 2.6,
      boxSelectionEnabled: false,
    })
    cyRef.current = cy

    const syncGrid = () => {
      const zoom = cy.zoom()
      const pan = cy.pan()
      const minor = 24 * zoom
      host.style.backgroundSize = `${minor * 5}px ${minor * 5}px, ${minor * 5}px ${minor * 5}px, ${minor}px ${minor}px, ${minor}px ${minor}px`
      host.style.backgroundPosition = `${pan.x}px ${pan.y}px`
    }
    cy.on('viewport', () => {
      syncGrid()
      setTip(null)
    })

    cy.on('tap', 'node', (event: EventObject) => onSelectRef.current(event.target.id()))
    cy.on('tap', (event: EventObject) => {
      if (event.target !== cy) return
      focusRef.current = null
      emphasize()
      onSelectRef.current(null)
      onBackgroundRef.current?.()
    })
    cy.on('mouseover', 'node', (event: EventObject) => {
      hoverRef.current = event.target.id()
      host.style.cursor = 'pointer'
      emphasize()
    })
    cy.on('mouseout', 'node', () => {
      hoverRef.current = null
      host.style.cursor = ''
      emphasize()
    })
    cy.on('mouseover', 'edge', (event: EventObject) => {
      const edge = mergedRef.current.find((item) => item.id === event.target.id())
      if (!edge) return
      event.target.addClass('hover')
      const note = noteFor(edge, alertsRef.current.filter((alert) => alert.status === 'open'))
      const lines = [describeEdge(edge)]
      for (const part of edge.parts) {
        if (!part.label) continue
        lines.push(`${part.kind === 'runtime_call' ? 'Trace' : part.kind === 'intended' ? 'Intent' : 'Code'}: ${part.label}`)
      }
      if (note.alert) lines.push(ALERT_META[note.alert.kind]?.explain ?? note.alert.description)
      const pos = event.renderedPosition ?? { x: 0, y: 0 }
      setTip({ x: pos.x, y: pos.y, title: `${edge.sourceName} → ${edge.targetName}`, lines, tone: note.cls })
    })
    cy.on('mouseout', 'edge', (event: EventObject) => {
      event.target.removeClass('hover')
      setTip(null)
    })

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let alive = true
    const timers: number[] = []

    // The one orchestrated moment: the map draws itself left to right.
    if (!reduce) {
      cy.elements().style('opacity', 0)
      const xs = cy.nodes().map((node) => node.position('x'))
      const minX = Math.min(...xs)
      const span = Math.max(1, Math.max(...xs) - minX)
      cy.nodes().forEach((node) => {
        const delay = ((node.position('x') - minX) / span) * 420
        timers.push(window.setTimeout(() => alive && node.animate({ style: { opacity: 1 }, duration: 260 }), delay))
      })
      cy.edges().forEach((edge) => {
        const delay = 160 + ((edge.target().position('x') - minX) / span) * 420
        timers.push(window.setTimeout(() => alive && edge.animate({ style: { opacity: 1 }, duration: 300 }), delay))
      })
      timers.push(
        window.setTimeout(() => {
          if (alive) cy.elements().removeStyle('opacity')
        }, 1000),
      )
    }

    // Traffic: dashes travel along runtime-only lines in the direction of the call.
    let offset = 0
    const traffic = reduce
      ? 0
      : window.setInterval(() => {
          if (!alive || document.hidden) return
          offset = (offset + 1) % 28
          cy.edges('[status = "runtime"]').style('line-dash-offset', -offset)
        }, 70)

    // Keep the whole map framed until the person pans or zooms it themselves.
    let touched = false
    const markTouched = () => {
      touched = true
    }
    host.addEventListener('pointerdown', markTouched)
    host.addEventListener('wheel', markTouched, { passive: true })
    const frame = () => {
      if (!alive) return
      cy.resize()
      if (!touched) cy.viewport(safeViewport(cy, cy.elements()))
      syncGrid()
    }
    requestAnimationFrame(frame)
    const observer = new ResizeObserver(frame)
    observer.observe(host)

    return () => {
      alive = false
      timers.forEach((id) => window.clearTimeout(id))
      if (traffic) window.clearInterval(traffic)
      observer.disconnect()
      host.removeEventListener('pointerdown', markTouched)
      host.removeEventListener('wheel', markTouched)
      cy.destroy()
      cyRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Drift annotations follow alerts in place.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const open = alerts.filter((alert) => alert.status === 'open')
    const high = new Set<string>()
    const medium = new Set<string>()
    for (const alert of open) {
      const bucket = alert.severity === 'high' ? high : medium
      bucket.add(alert.source)
      bucket.add(alert.target)
    }
    cy.batch(() => {
      cy.edges().forEach((element) => {
        const edge = merged.find((item) => item.id === element.id())
        if (!edge) return
        const note = noteFor(edge, open)
        element.removeClass('drift stale missing')
        if (note.cls) element.addClass(note.cls)
        element.data('caption', note.caption)
      })
      cy.nodes().forEach((element) => {
        const label = element.data('label') as string
        element.removeClass('warn caution')
        if (high.has(label)) element.addClass('warn')
        else if (medium.has(label)) element.addClass('caution')
      })
    })
  }, [alerts, merged, key])

  // Legend rows hide elements in place.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    const off = toggles.filter((item) => hidden.includes(item.id))
    cy.batch(() => {
      cy.elements().removeClass('hidden')
      cy.nodes().forEach((node) => {
        if (off.some((item) => item.test({ group: 'nodes', kind: node.data('kind') }))) node.addClass('hidden')
      })
      cy.edges().forEach((edge) => {
        if (off.some((item) => item.test({ group: 'edges', channel: edge.data('channel'), status: edge.data('status') }))) edge.addClass('hidden')
      })
    })
  }, [hidden, key, toggles])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.nodes().removeClass('picked')
    if (selectedId) cy.getElementById(selectedId).addClass('picked')
  }, [selectedId, key])

  useEffect(() => {
    matchRef.current = query.trim() ? new Set(results.map((node) => node.id)) : null
    emphasize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, query, key])

  function pick(node: GraphNode) {
    setQuery('')
    setSearchOpen(false)
    onSelectRef.current(node.id)
    const cy = cyRef.current
    const element = cy?.getElementById(node.id)
    if (cy && element && element.nonempty()) {
      cy.animate({ center: { eles: element }, zoom: Math.max(cy.zoom(), 1), duration: 360, easing: 'ease-out-cubic' })
    }
  }

  return (
    <div className="map-card">
      <div ref={hostRef} className="cy" role="application" aria-label="Architecture map. Drag to pan, scroll to zoom, click a box for details." />

      {tip ? (
        <div className={`map-tip ${tip.tone}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
          <strong>{tip.title}</strong>
          {tip.lines.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </div>
      ) : null}

      <div className="hud">
        <div className="hud-tl">{hudTopLeft}</div>
        <div className="hud-tc">{hudTopCenter}</div>
        <div className="map-search hud-tr">
          <label className="search-field">
            <Icon name="search" />
            <input
              ref={searchRef}
              value={query}
              placeholder="Find a service, route or host"
              aria-label="Find on map"
              aria-expanded={searchOpen && results.length > 0}
              aria-controls="map-search-results"
              onFocus={() => setSearchOpen(true)}
              onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
              onChange={(event) => {
                setQuery(event.target.value)
                setSearchOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && results[0]) pick(results[0])
                if (event.key === 'Escape') {
                  setQuery('')
                  event.currentTarget.blur()
                }
              }}
            />
            {query ? (
              <button type="button" className="field-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <Icon name="close" size={14} />
              </button>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
          {searchOpen && query.trim() ? (
            <ul className="search-results" id="map-search-results" role="listbox">
              {results.length === 0 ? <li className="none">Nothing in this view matches “{query.trim()}”.</li> : null}
              {results.map((node) => (
                <li key={node.id}>
                  <button type="button" role="option" aria-selected={false} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(node)}>
                    <img src={iconSvg(node.kind, NODE_META[node.kind]?.tint ?? INK)} alt="" />
                    <span>{node.label}</span>
                    <small>{NODE_META[node.kind]?.label ?? node.kind}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className={legendOpen ? 'legend hud-bl open' : 'legend hud-bl'}>
          <button type="button" className="legend-head" aria-expanded={legendOpen} onClick={() => setLegendOpen((open) => !open)}>
            <Icon name="layers" />
            <span>Key</span>
            {hidden.length > 0 ? <em>{hidden.length} hidden</em> : null}
            <Icon name="chevronDown" className="legend-chevron" />
          </button>
          {legendOpen ? (
            <div className="legend-body">
              <ul>
                {present.map((item) => {
                  const off = hidden.includes(item.id)
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={!off}
                        title={`${item.hint} Click to ${off ? 'show' : 'hide'}.`}
                        className={off ? 'off' : undefined}
                        onClick={() => setHidden((current) => (off ? current.filter((id) => id !== item.id) : [...current, item.id]))}
                      >
                        {item.icon ? (
                          <span className={`key-node ${item.icon}`}>
                            <img src={iconSvg(item.icon, NODE_META[item.icon]?.tint ?? INK)} alt="" />
                          </span>
                        ) : (
                          <svg width="30" height="12" aria-hidden="true" className="key-line">
                            <line x1="2" y1="6" x2="28" y2="6" stroke={item.line?.color} strokeWidth={item.line?.width ?? 2.4} strokeLinecap="round" strokeDasharray={item.line?.dash} />
                          </svg>
                        )}
                        <span className="key-label">{item.label}</span>
                        <Icon name={off ? 'eyeOff' : 'eye'} size={14} className="legend-eye" />
                      </button>
                    </li>
                  )
                })}
              </ul>
              <p className="legend-note">
                <span className="key-halo" aria-hidden="true" /> Red or ochre outline: part of a high or medium alert
              </p>
            </div>
          ) : null}
        </div>

        <div className="zoom-controls hud-br" role="group" aria-label="Map controls">
          <button type="button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => cyRef.current && zoomAround(cyRef.current, 1.25)}>
            <Icon name="plus" />
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => cyRef.current && zoomAround(cyRef.current, 0.8)}>
            <Icon name="minus" />
          </button>
          <button type="button" aria-label="Fit map to screen" title="Fit to screen (F)" onClick={() => cyRef.current && flyTo(visibleEles(cyRef.current))}>
            <Icon name="fit" />
          </button>
          <div className="help-wrap">
            <button type="button" aria-label="Keyboard shortcuts" aria-expanded={helpOpen} title="Keyboard shortcuts" onClick={() => setHelpOpen((open) => !open)}>
              <Icon name="keyboard" />
            </button>
            {helpOpen ? (
              <div className="help-pop" role="dialog" aria-label="Keyboard shortcuts">
                <dl>
                  <dt><Kbd>/</Kbd></dt><dd>Find on map</dd>
                  <dt><Kbd>F</Kbd></dt><dd>Fit to screen</dd>
                  <dt><Kbd>+</Kbd> <Kbd>−</Kbd></dt><dd>Zoom</dd>
                  <dt><Kbd>N</Kbd> <Kbd>P</Kbd></dt><dd>Next or previous alert</dd>
                  <dt><Kbd>1</Kbd> to <Kbd>4</Kbd></dt><dd>Switch view</dd>
                  <dt><Kbd>Esc</Kbd></dt><dd>Clear selection</dd>
                </dl>
              </div>
            ) : null}
          </div>
        </div>
        <div className="hud-bc">{hudBottomCenter}</div>
      </div>
    </div>
  )
})

// Fit inside the part of the canvas not covered by floating panels.
// Two candidate areas are tried (right of the panels, or below/above them) and the
// one that shows the map largest wins.
function safeViewport(cy: Core, eles: cytoscape.CollectionReturnValue, extra = 0) {
  const width = cy.width()
  const height = cy.height()
  const host = cy.container()
  const root = host?.closest('.canvas') ?? host
  const hostBox = host?.getBoundingClientRect()
  const measure = (selector: string) => {
    const el = root?.querySelector(selector)
    if (!el || !hostBox) return null
    const box = el.getBoundingClientRect()
    return { left: box.left - hostBox.left, right: box.right - hostBox.left, top: box.top - hostBox.top, bottom: box.bottom - hostBox.top }
  }
  const status = measure('.status-card')
  const legend = measure('.legend')
  const search = measure('.map-search')
  const zoomBar = measure('.zoom-controls')
  const blockers = ['.status-card', '.legend', '.map-search', '.zoom-controls', '.review-cta', '.navigator']
    .map(measure)
    .filter((item): item is NonNullable<typeof item> => item !== null)
  const pad = 24 + extra
  const above = blockers.filter((item) => (item.top + item.bottom) / 2 < height / 2)
  const below = blockers.filter((item) => (item.top + item.bottom) / 2 >= height / 2)
  // Band between the top and bottom panels, full width.
  const band = {
    left: pad,
    right: pad,
    top: Math.max(pad, ...above.map((item) => item.bottom + 12 + extra)),
    bottom: Math.max(pad, ...below.map((item) => height - item.top + 12 + extra)),
  }
  const candidates = [band]
  if (width > 860) {
    // Column right of the left-hand panels.
    candidates.push({
      left: Math.max(status?.right ?? 0, legend?.right ?? 0) + 16 + extra,
      right: Math.max(pad, zoomBar ? width - zoomBar.left + 12 : pad),
      top: Math.max(pad, search ? search.bottom + 12 : pad),
      bottom: pad + 40,
    })
  }
  const box = eles.boundingBox({})
  let best = { zoom: 0, pan: { x: 0, y: 0 } }
  for (const inset of candidates) {
    const availW = Math.max(80, width - inset.left - inset.right)
    const availH = Math.max(80, height - inset.top - inset.bottom)
    const zoom = Math.max(cy.minZoom(), Math.min(1.15, availW / Math.max(1, box.w), availH / Math.max(1, box.h)))
    if (zoom > best.zoom) {
      best = {
        zoom,
        pan: { x: inset.left + availW / 2 - (box.x1 + box.w / 2) * zoom, y: inset.top + availH / 2 - (box.y1 + box.h / 2) * zoom },
      }
    }
  }
  return best
}

function zoomAround(cy: Core, factor: number) {
  cy.animate(
    {
      zoom: {
        level: Math.min(2.6, Math.max(0.2, cy.zoom() * factor)),
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      },
    },
    { duration: 160 },
  )
}

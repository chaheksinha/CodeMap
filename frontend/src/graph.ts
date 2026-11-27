// Turns raw source / runtime / intent edges into one line per connection,
// tagged with whether the code and the trace agree about it.

import { ALERT_META } from './legend'
import type { AlertItem, GraphEdge, GraphNode } from './types'

export type Channel = 'call' | 'data' | 'intended' | 'route' | 'import'
export type Agreement = 'both' | 'code' | 'runtime' | 'none'

export type MapEdge = {
  id: string
  source: string
  target: string
  sourceName: string
  targetName: string
  channel: Channel
  status: Agreement
  parts: GraphEdge[]
}

export type EdgeNote = { cls: '' | 'drift' | 'stale' | 'missing'; caption: string; alert?: AlertItem }

export function mergeEdges(nodes: GraphNode[], edges: GraphEdge[]): MapEdge[] {
  const kindOf = new Map(nodes.map((node) => [node.id, node.kind]))
  const groups = new Map<string, MapEdge>()
  const out: MapEdge[] = []
  for (const edge of edges) {
    const base = {
      source: edge.source,
      target: edge.target,
      sourceName: edge.source_name ?? edge.source,
      targetName: edge.target_name ?? edge.target.replace(/^external:/, ''),
    }
    if (edge.kind === 'intended' || edge.kind === 'exposes' || edge.kind === 'import') {
      out.push({
        id: `${edge.kind}:${edge.id}`,
        ...base,
        channel: edge.kind === 'intended' ? 'intended' : edge.kind === 'exposes' ? 'route' : 'import',
        status: 'none',
        parts: [edge],
      })
      continue
    }
    const key = `${edge.source}>${edge.target}`
    let group = groups.get(key)
    if (!group) {
      group = { id: `pair:${key}`, ...base, channel: 'call', status: 'code', parts: [] }
      groups.set(key, group)
      out.push(group)
    }
    group.parts.push(edge)
  }
  for (const group of groups.values()) {
    const code = group.parts.some((part) => part.kind === 'call' || part.kind === 'reads')
    const runtime = group.parts.some((part) => part.kind === 'runtime_call')
    group.status = code && runtime ? 'both' : runtime ? 'runtime' : 'code'
    const data = group.parts.some((part) => part.kind === 'reads') || kindOf.get(group.target) === 'database'
    group.channel = data ? 'data' : 'call'
  }
  return out
}

export function noteFor(edge: MapEdge, open: AlertItem[]): EdgeNote {
  const match = (kinds: string[]) =>
    open.find((alert) => kinds.includes(alert.kind) && alert.source === edge.sourceName && alert.target === edge.targetName)
  if (edge.channel === 'intended') {
    const alert = match(['missing_intended'])
    return alert ? { cls: 'missing', caption: ALERT_META.missing_intended.edgeCaption, alert } : { cls: '', caption: '' }
  }
  if (edge.status === 'runtime') {
    const alert = match(['undocumented_runtime', 'unexpected_external'])
    if (alert) return { cls: 'drift', caption: ALERT_META[alert.kind].edgeCaption, alert }
  }
  if (edge.status === 'code') {
    const alert = match(['unobserved_static'])
    if (alert) return { cls: 'stale', caption: '', alert }
  }
  return { cls: '', caption: '' }
}

export function describeEdge(edge: MapEdge): string {
  if (edge.channel === 'intended') return 'Intended'
  if (edge.channel === 'route') return 'Serves route'
  if (edge.channel === 'import') return 'Import'
  const what = edge.channel === 'data' ? 'Data access' : 'Call'
  if (edge.status === 'both') return `${what} in code and at runtime`
  if (edge.status === 'runtime') return `${what} only at runtime`
  return `${what} in code`
}

// One vocabulary for the whole app: every screen, the map, the legend and the
// onboarding story read their colors and words from here.

import type { AlertItem, ViewName } from './types'

export const COLORS = {
  ink: '#14202B',
  paper: '#EDF1F4',
  source: '#C98A1B', // only in code
  agree: '#0E8A7A', // code and runtime agree
  runtime: '#0E8A7A', // seen in the trace
  drift: '#D7322B', // disagreement
  reads: '#2F6FB3', // data access
  intent: '#6A4FD0', // what you expect
  route: '#9AA6B0', // service serves route
  caution: '#C98A1B',
} as const

export type NodeKind = 'service' | 'api' | 'database' | 'external' | 'file'

export const NODE_META: Record<string, { label: string; plural: string; tint: string; hint: string }> = {
  service: { label: 'Service', plural: 'Services', tint: '#14202B', hint: 'A top-level folder in the uploaded source.' },
  api: { label: 'Route', plural: 'Routes', tint: '#55636F', hint: 'An HTTP route found from a decorator in the source.' },
  database: { label: 'Database', plural: 'Databases', tint: COLORS.reads, hint: 'A data store named in the source.' },
  external: { label: 'Outside host', plural: 'Outside hosts', tint: '#7A5A4E', hint: 'A host that is not part of this repository.' },
  file: { label: 'File', plural: 'Files', tint: '#55636F', hint: 'A source file.' },
}

export const EDGE_META: Record<string, { label: string; color: string; hint: string; dash: 'solid' | 'dashed' | 'dotted' }> = {
  call: { label: 'Call in source', color: COLORS.source, hint: 'An HTTP call or import found in the code.', dash: 'solid' },
  reads: { label: 'Data access', color: COLORS.reads, hint: 'The code reads or writes this database.', dash: 'solid' },
  runtime_call: { label: 'Seen at runtime', color: COLORS.runtime, hint: 'The trace recorded this call.', dash: 'dashed' },
  intended: { label: 'Intended', color: COLORS.intent, hint: 'A link you said should exist.', dash: 'dotted' },
  exposes: { label: 'Exposes route', color: COLORS.route, hint: 'The service serves this route.', dash: 'solid' },
  import: { label: 'Import', color: '#9AA6B0', hint: 'A module import.', dash: 'solid' },
}

export const VIEWS: { id: ViewName; label: string; hint: string }[] = [
  { id: 'combined', label: 'Everything', hint: 'Source, runtime and intent together. Drift is highlighted.' },
  { id: 'static', label: 'Source', hint: 'Only what the code says: calls, data access and routes.' },
  { id: 'runtime', label: 'Runtime', hint: 'Only what the trace recorded while the system ran.' },
  { id: 'intended', label: 'Intent', hint: 'Only the links you said should exist.' },
]

export type AlertKindMeta = {
  label: string
  short: string
  explain: string
  action: string
  edgeCaption: string
}

export const ALERT_META: Record<string, AlertKindMeta> = {
  undocumented_runtime: {
    label: 'Runtime call not in source',
    short: 'Not in source',
    explain: 'The trace shows this call, but no code in the upload makes it.',
    action: 'Find what makes the call (config, an SDK, a sidecar) and add it to the code or docs. Dismiss it if it is expected.',
    edgeCaption: 'not in source',
  },
  unexpected_external: {
    label: 'Call leaves the project',
    short: 'Outside call',
    explain: 'At runtime this service called a host that is not part of the uploaded code.',
    action: 'Check that the host is expected and owned. If it is, dismiss this alert. If not, track down the caller.',
    edgeCaption: 'outside',
  },
  unobserved_static: {
    label: 'Never seen at runtime',
    short: 'Never ran',
    explain: 'The code depends on this, but the trace never shows the call.',
    action: 'It may be dead code, or the trace may not cover this path. Capture a longer trace or remove the dependency.',
    edgeCaption: 'never ran',
  },
  missing_intended: {
    label: 'Intended link missing',
    short: 'Missing',
    explain: 'You marked this link as expected, and neither the source nor the trace has it.',
    action: 'Build the link, or remove the intent if the design changed.',
    edgeCaption: 'missing',
  },
}

export function alertMeta(alert: Pick<AlertItem, 'kind' | 'title' | 'description'>): AlertKindMeta {
  return (
    ALERT_META[alert.kind] ?? {
      label: alert.title,
      short: alert.title,
      explain: alert.description,
      action: '',
      edgeCaption: '',
    }
  )
}

export const SEVERITY_LABEL: Record<AlertItem['severity'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export function iconSvg(kind: string, color: string): string {
  const body: Record<string, string> = {
    service: `<rect x='3.5' y='4' width='17' height='6.5' rx='1.6'/><rect x='3.5' y='13.5' width='17' height='6.5' rx='1.6'/><circle cx='7.2' cy='7.25' r='0.9' fill='${color}' stroke='none'/><circle cx='7.2' cy='16.75' r='0.9' fill='${color}' stroke='none'/>`,
    api: `<path d='M9 7 4.5 12 9 17M15 7l4.5 5L15 17'/>`,
    database: `<ellipse cx='12' cy='6' rx='7' ry='2.8'/><path d='M5 6v12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V6'/><path d='M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8'/>`,
    external: `<circle cx='12' cy='12' r='8.2'/><path d='M3.8 12h16.4M12 3.8c2.5 2.6 2.5 13.8 0 16.4M12 3.8c-2.5 2.6-2.5 13.8 0 16.4'/>`,
    file: `<path d='M7 3h7l5 5v13H7z'/><path d='M14 3v5h5'/>`,
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${body[kind] ?? body.service}</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

export type ProjectSummary = {
  id: number
  name: string
  description: string
  open_alerts: number
  high_alerts: number
  component_count: number
  source_name: string | null
  trace_name: string | null
  created_at: string
}

export type GraphNode = {
  id: string
  label: string
  kind: string
  service?: string
  warn: boolean
  width: number
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  kind: string
  origin?: string
  source_name?: string
  target_name?: string
  label: string
}

export type SourceFile = {
  path: string
  service: string
  symbols: string[]
  routes: string[]
  libraries: string[]
  imports: string[]
}

export type AlertItem = {
  id: number
  severity: 'high' | 'medium' | 'low'
  kind: string
  title: string
  source: string
  target: string
  description: string
  status: 'open' | 'dismissed'
}

export type IntentItem = {
  id: number
  source: string
  target: string
}

export type ActivityItem = {
  action: string
  detail: string
  created_at: string
}

export type Snapshot = {
  project: {
    id: number
    name: string
    description: string
    trace_name: string | null
    source_name: string | null
  }
  view: 'static' | 'runtime' | 'combined' | 'intended'
  stats: {
    components: number
    static_links: number
    runtime_calls: number
    open_alerts: number
  }
  severities: { high: number; medium: number; low: number }
  nodes: GraphNode[]
  edges: GraphEdge[]
  files: SourceFile[]
  alerts: AlertItem[]
  intents: IntentItem[]
  activity: ActivityItem[]
}

export type ViewName = Snapshot['view']

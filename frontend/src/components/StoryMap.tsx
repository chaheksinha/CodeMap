import { useState } from 'react'
import { COLORS } from '../legend'

const beats = [
  {
    id: 'agree',
    label: 'Code and runtime agree',
    title: 'Teal means both sides agree',
    body: 'The gateway calls user-service and order-service in the code, and the trace saw both calls. Nothing to do here.',
  },
  {
    id: 'runtime',
    label: 'Only at runtime',
    title: 'A call the code never makes',
    body: 'The trace shows order-service calling notify, but no source file does. CodeMap draws it red and raises an alert.',
  },
  {
    id: 'outside',
    label: 'Leaves the project',
    title: 'A host outside the repository',
    body: 'payments.example.com is not one of these services, and the trace called it anyway.',
  },
] as const

type BeatId = (typeof beats)[number]['id']

export function StoryMap() {
  const [beat, setBeat] = useState<BeatId>('runtime')
  const active = beats.find((item) => item.id === beat) ?? beats[1]

  return (
    <figure className="story" data-beat={beat}>
      <svg
        className="story-svg"
        viewBox="0 0 640 380"
        role="img"
        aria-label="Demo shop map. api-gateway calls user-service and order-service. user-service reads MySQL. order-service calls notify only at runtime and calls an outside payments host."
      >
        <defs>
          <pattern id="story-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#D5DDE3" strokeWidth="1" />
          </pattern>
          <marker id="arrow-agree" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill={COLORS.agree} />
          </marker>
          <marker id="arrow-drift" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill={COLORS.drift} />
          </marker>
          <marker id="arrow-reads" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill={COLORS.reads} />
          </marker>
        </defs>
        <rect width="640" height="380" fill="url(#story-grid)" />

        <g className={beat === 'agree' ? 'beat on' : 'beat'} fill="none" strokeWidth="3.4">
          <path className="draw" d="M150 190 H195 V105 H262" stroke={COLORS.agree} markerEnd="url(#arrow-agree)" />
          <path className="draw" d="M150 190 H195 V265 H262" stroke={COLORS.agree} markerEnd="url(#arrow-agree)" />
          <path className="draw" d="M330 82 V52 H446" stroke={COLORS.reads} strokeWidth="3" markerEnd="url(#arrow-reads)" />
        </g>
        <g className={beat === 'runtime' ? 'beat on' : 'beat'} fill="none">
          <path className="flow" d="M400 255 H440 V150 H478" stroke={COLORS.drift} strokeWidth="3.4" strokeDasharray="9 7" markerEnd="url(#arrow-drift)" />
        </g>
        <g className={beat === 'outside' ? 'beat on' : 'beat'} fill="none">
          <path className="flow" d="M400 278 H440 V318 H478" stroke={COLORS.drift} strokeWidth="3.4" strokeDasharray="9 7" markerEnd="url(#arrow-drift)" />
        </g>

        <Station x={30} y={168} w={120} label="api-gateway" />
        <Station x={262} y={82} w={136} label="user-service" />
        <Station x={262} y={242} w={136} label="order-service" warn={beat !== 'agree'} />
        <Station x={478} y={128} w={120} label="notify" warn={beat === 'runtime'} />
        <Station x={478} y={296} w={140} label="payments" kind="external" warn={beat === 'outside'} />
        <Station x={446} y={32} w={100} label="MySQL" kind="database" />

        {beat !== 'agree' ? (
          <g className="tag" transform={beat === 'runtime' ? 'translate(386 186)' : 'translate(388 330)'}>
            <rect width={beat === 'runtime' ? 104 : 66} height="22" rx="5" fill={COLORS.drift} />
            <text x={beat === 'runtime' ? 52 : 33} y="15" textAnchor="middle">
              {beat === 'runtime' ? 'not in source' : 'outside'}
            </text>
          </g>
        ) : null}
      </svg>
      <div className="story-picks" role="tablist" aria-label="Walk through the demo map">
        {beats.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={beat === item.id}
            className={beat === item.id ? `pick on ${item.id}` : `pick ${item.id}`}
            onClick={() => setBeat(item.id)}
          >
            <i aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
      <figcaption className="story-caption" aria-live="polite">
        <strong>{active.title}</strong>
        <span>{active.body}</span>
      </figcaption>
    </figure>
  )
}

function Station({ x, y, w, label, warn = false, kind = 'service' }: { x: number; y: number; w: number; label: string; warn?: boolean; kind?: 'service' | 'database' | 'external' }) {
  return (
    <g transform={`translate(${x} ${y})`} className={`station ${kind} ${warn ? 'warn' : ''}`}>
      <rect width={w} height="44" rx="9" />
      <text x={w / 2} y="27" textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

import { useMemo, useState } from 'react'
import { cellValue, numericValue } from './model'
import type { ChartConfig, Color, DbAttrs, Row } from './types'
import { show } from './formula'

interface Group {
  key: string
  label: string
  value: number
  color: Color | null
}

const MAX_GROUPS = 8 // more categories fold into "Andere" (never invent extra hues)

/** Groups rows by the x property and aggregates count / sum / average of y. */
function groupRows(db: DbAttrs, rows: Row[], cfg: ChartConfig): { groups: Group[]; temporal: boolean } {
  const x = db.properties.find((p) => p.id === cfg.x)
  const y = cfg.y ? db.properties.find((p) => p.id === cfg.y) : undefined
  if (!x) return { groups: [], temporal: false }

  const buckets = new Map<string, { label: string; color: Color | null; values: number[]; order: number }>()
  const add = (key: string, label: string, color: Color | null, order: number, row: Row) => {
    const b = buckets.get(key) ?? { label, color, values: [], order }
    b.values.push(y ? numericValue(db, row, y) ?? 0 : 1)
    buckets.set(key, b)
  }

  const temporal = x.type === 'date'
  let monthly = false
  if (temporal) {
    const times = rows.map((r) => r.cells[x.id]).filter((d): d is string => typeof d === 'string' && !!d).map((d) => Date.parse(d))
    monthly = times.length > 0 && Math.max(...times) - Math.min(...times) > 62 * 86_400_000
  }

  for (const row of rows) {
    const c = row.cells[x.id]
    if (x.type === 'select' || x.type === 'status') {
      const i = x.options?.findIndex((o) => o.id === c) ?? -1
      const o = i >= 0 ? x.options![i] : null
      add(o?.id ?? '∅', o?.name ?? 'Leer', o?.color ?? null, o ? i : 999, row)
    } else if (x.type === 'multi_select') {
      const ids = Array.isArray(c) ? c : []
      if (!ids.length) add('∅', 'Leer', null, 999, row)
      for (const id of ids) {
        const i = x.options?.findIndex((o) => o.id === id) ?? -1
        if (i >= 0) add(id, x.options![i].name, x.options![i].color, i, row)
      }
    } else if (x.type === 'checkbox') {
      add(c ? 'yes' : 'no', c ? 'Ja' : 'Nein', c ? 'green' : 'gray', c ? 0 : 1, row)
    } else if (temporal) {
      if (typeof c !== 'string' || !c) continue
      const key = monthly ? c.slice(0, 7) : c.slice(0, 10)
      const d = new Date(key + (monthly ? '-01' : '') + 'T00:00')
      const label = d.toLocaleDateString('de-DE', monthly ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' })
      add(key, label, null, d.getTime(), row)
    } else {
      let label: string
      try {
        label = show(cellValue(db, row, x)) || 'Leer'
      } catch {
        label = '⚠'
      }
      add(label, label, null, 0, row)
    }
  }

  const agg = (v: number[]) => (cfg.agg === 'avg' && y ? v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) : v.reduce((a, b) => a + b, 0))
  let groups = [...buckets.entries()].map(([key, b]) => ({ key, label: b.label, value: agg(b.values), color: b.color, order: b.order }))
  if (temporal || x.type === 'select' || x.type === 'status' || x.type === 'multi_select' || x.type === 'checkbox')
    groups.sort((a, b) => a.order - b.order)
  else groups.sort((a, b) => b.value - a.value)

  if (!temporal && groups.length > MAX_GROUPS) {
    const rest = groups.slice(MAX_GROUPS - 1)
    groups = [
      ...groups.slice(0, MAX_GROUPS - 1),
      { key: 'other', label: `Andere (${rest.length})`, value: rest.reduce((s, g) => s + g.value, 0), color: 'gray', order: 1e9 },
    ]
  }
  return { groups, temporal }
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString('de-DE') : v.toLocaleString('de-DE', { maximumFractionDigits: 1 }))

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1)
}

interface Props {
  db: DbAttrs
  rows: Row[]
  config: ChartConfig
}

export default function Chart({ db, rows, config }: Props) {
  const { groups, temporal } = useMemo(() => groupRows(db, rows, config), [db, rows, config])
  const [hover, setHover] = useState<number | null>(null)
  const y = config.y ? db.properties.find((p) => p.id === config.y) : undefined
  const measure = !y || config.agg === 'count' ? 'Anzahl' : `${config.agg === 'sum' ? 'Summe' : 'Ø'} ${y.name}`

  if (!groups.length) return <div className="chart-empty">Keine Daten für dieses Diagramm.</div>
  const total = groups.reduce((s, g) => s + g.value, 0)
  const kind = config.kind === 'line' && groups.length < 2 ? 'bar' : config.kind

  // colour follows the option itself; groups without one use the first series hue
  const fill = (g: Group) => (g.color && g.color !== 'gray' ? `var(--c-${g.color})` : g.color === 'gray' ? 'var(--c-gray)' : 'var(--series-1)')

  if (kind === 'donut') {
    const R = 74, r = 50, cx = 90, cy = 90
    let a0 = -Math.PI / 2
    const arcs = groups.map((g) => {
      const a1 = a0 + (total ? (g.value / total) * Math.PI * 2 : 0)
      const large = a1 - a0 > Math.PI ? 1 : 0
      const p = (a: number, rad: number) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`
      const d =
        a1 - a0 >= Math.PI * 2 - 1e-6
          ? `M ${p(0, R)} A ${R} ${R} 0 1 1 ${p(Math.PI, R)} A ${R} ${R} 0 1 1 ${p(0, R)} M ${p(0, r)} A ${r} ${r} 0 1 0 ${p(Math.PI, r)} A ${r} ${r} 0 1 0 ${p(0, r)} Z`
          : `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`
      a0 = a1
      return d
    })
    const h = hover !== null ? groups[hover] : null
    return (
      <div className="chart chart-donut">
        <svg viewBox="0 0 180 180" width="180" height="180" role="img" aria-label={`${measure} nach ${db.properties.find((p) => p.id === config.x)?.name}`}>
          {arcs.map((d, i) => (
            <path
              key={groups[i].key}
              d={d}
              fill={fill(groups[i])}
              stroke="var(--bg)"
              strokeWidth={2}
              opacity={hover === null || hover === i ? 1 : 0.35}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
          <text x={cx} y={cy - 4} textAnchor="middle" className="chart-hero">{fmt(h ? h.value : total)}</text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="chart-sub">
            {h ? `${h.label} · ${Math.round((h.value / Math.max(total, 1e-9)) * 100)}%` : measure}
          </text>
        </svg>
        <ul className="chart-legend">
          {groups.map((g, i) => (
            <li key={g.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={hover === i ? 'on' : ''}>
              <i style={{ background: fill(g) }} />
              <span>{g.label}</span>
              <b>{fmt(g.value)}</b>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // bar / line share axes
  const W = 640, H = 240, L = 40, B = 34, T = 14
  const max = niceMax(Math.max(...groups.map((g) => g.value)))
  const sy = (v: number) => T + (H - T - B) * (1 - v / max)
  const step = (W - L - 8) / groups.length
  const ticks = [0, max / 2, max]
  const labelEvery = Math.ceil(groups.length / Math.floor((W - L) / 64))

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label={measure}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - 8} y1={sy(t)} y2={sy(t)} className="chart-grid" />
            <text x={L - 8} y={sy(t) + 4} textAnchor="end" className="chart-axis">{fmt(t)}</text>
          </g>
        ))}
        {kind === 'bar'
          ? groups.map((g, i) => {
              const bw = Math.min(48, step - 6)
              const x = L + i * step + (step - bw) / 2
              const top = sy(g.value), base = sy(0)
              const r = Math.min(4, (base - top) / 2)
              // rounded data end only, flat on the baseline
              const d = `M ${x} ${base} V ${top + r} Q ${x} ${top} ${x + r} ${top} H ${x + bw - r} Q ${x + bw} ${top} ${x + bw} ${top + r} V ${base} Z`
              return (
                <g key={g.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
                  <path d={d} fill={temporal ? 'var(--series-1)' : fill(g)} opacity={hover === null || hover === i ? 1 : 0.45} />
                </g>
              )
            })
          : (() => {
              const pts = groups.map((g, i) => [L + i * step + step / 2, sy(g.value)] as const)
              return (
                <>
                  <path d={`M ${pts.map((p) => p.join(' ')).join(' L ')}`} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
                  {pts.map(([px, py], i) => (
                    <g key={groups[i].key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <rect x={L + i * step} y={T} width={step} height={H - T - B} fill="transparent" />
                      {hover === i && <line x1={px} x2={px} y1={T} y2={H - B} className="chart-cross" />}
                      <circle cx={px} cy={py} r={hover === i ? 5 : 4} fill="var(--series-1)" stroke="var(--bg)" strokeWidth={2} />
                    </g>
                  ))}
                </>
              )
            })()}
        <line x1={L} x2={W - 8} y1={sy(0)} y2={sy(0)} className="chart-base" />
        {groups.map((g, i) =>
          i % labelEvery === 0 ? (
            <text key={g.key} x={L + i * step + step / 2} y={H - B + 18} textAnchor="middle" className="chart-axis">
              {g.label.length > 12 ? g.label.slice(0, 11) + '…' : g.label}
            </text>
          ) : null,
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${((L + hover * step + step / 2) / W) * 100}%` }}>
          <span>{groups[hover].label}</span>
          <b>{fmt(groups[hover].value)}</b>
          <small>{measure}</small>
        </div>
      )}
    </div>
  )
}


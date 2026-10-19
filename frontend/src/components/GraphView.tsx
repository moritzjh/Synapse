import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { forceCollide, forceX, forceY } from 'd3-force'
import { api, type GraphData } from '../api'
import { Icon } from './Icons'

interface GNode {
  id: number
  title: string
  group: string
  degree: number
  x?: number
  y?: number
}

interface GLink {
  source: number | GNode
  target: number | GNode
  kind: 'link' | 'semantic' | 'child'
  weight: number
}

interface Settings {
  colorByFolder: boolean
  labels: 'auto' | 'always' | 'hover'
  semantic: boolean
  links: boolean
  subpages: boolean
  colorDepth: 1 | 2
  minSimilarity: number
  orphans: boolean
  arrows: boolean
  nodeSize: number
  repel: number
  distance: number
  depth: number
  hiddenGroups: string[]
}

const DEFAULTS: Settings = {
  colorByFolder: true,
  labels: 'auto',
  semantic: true,
  links: true,
  subpages: true,
  colorDepth: 1,
  minSimilarity: 0,
  orphans: true,
  arrows: false,
  nodeSize: 1,
  repel: 140,
  distance: 50,
  depth: 2,
  hiddenGroups: [],
}
const STORE = 'synapse.graph'
const ROOT_GROUP = 'Ohne Ordner'
const MAX_HUES = 8 // further folders share a neutral colour (never generate new hues)

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

const idOf = (v: number | GNode) => (typeof v === 'object' ? v.id : v)

export default function GraphView({ focus, onOpen, onFocus }: { focus?: number; onOpen: (id: number) => void; onFocus: (id?: number) => void }) {
  const [raw, setRaw] = useState<GraphData | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [panel, setPanel] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const fg = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const theme = useTheme()
  const fitted = useRef(false)

  useEffect(() => {
    api.graph().then(setRaw)
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(settings))
    } catch {
      /* private mode */
    }
  }, [settings])
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }))

  // Folder groups get colours in a fixed (alphabetical) order so a folder keeps its colour.
  const groups = useMemo(() => {
    const names = [...new Set((raw?.nodes ?? []).map((n) => groupOf(n.path, settings.colorDepth)))].sort((a, b) =>
      a === ROOT_GROUP ? 1 : b === ROOT_GROUP ? -1 : a.localeCompare(b, 'de'),
    )
    return names.map((name, i) => ({ name, color: name === ROOT_GROUP || i >= MAX_HUES ? theme.neutral : theme.series[i] }))
  }, [raw, theme, settings.colorDepth])
  const colorOf = useMemo(() => new Map(groups.map((g) => [g.name, g.color])), [groups])

  const data = useMemo(() => {
    if (!raw) return { nodes: [] as GNode[], links: [] as GLink[] }
    const hidden = new Set(settings.hiddenGroups)
    const depth = settings.colorDepth
    let nodes = raw.nodes.filter((n) => !hidden.has(groupOf(n.path, depth)))
    let ids = new Set(nodes.map((n) => n.id))
    // Subpages: "A/B.md" is the parent of everything in "A/B/".
    const byKey = new Map(raw.nodes.map((n) => [n.path.replace(/\.md$/, ''), n.id]))
    const childEdges = settings.subpages
      ? raw.nodes.flatMap((n) => {
          const key = n.path.replace(/\.md$/, '')
          const parent = key.includes('/') ? byKey.get(key.slice(0, key.lastIndexOf('/'))) : undefined
          return parent !== undefined ? [{ source: parent, target: n.id, kind: 'child' as const, weight: 1 }] : []
        })
      : []
    let links = [...raw.edges, ...childEdges].filter(
      (e) =>
        ids.has(e.source) &&
        ids.has(e.target) &&
        (e.kind === 'child' || (e.kind === 'link' ? settings.links : settings.semantic && e.weight >= settings.minSimilarity)),
    )
    if (focus !== undefined && ids.has(focus)) {
      // local graph: everything within `depth` hops of the focused note
      const adj = new Map<number, number[]>()
      for (const l of links) {
        adj.set(l.source, [...(adj.get(l.source) ?? []), l.target])
        adj.set(l.target, [...(adj.get(l.target) ?? []), l.source])
      }
      const keep = new Set([focus])
      let frontier = [focus]
      for (let d = 0; d < settings.depth; d++) {
        frontier = frontier.flatMap((id) => adj.get(id) ?? []).filter((id) => !keep.has(id))
        frontier.forEach((id) => keep.add(id))
      }
      nodes = nodes.filter((n) => keep.has(n.id))
      ids = keep
      links = links.filter((l) => keep.has(l.source) && keep.has(l.target))
    }
    const degree = new Map<number, number>()
    for (const l of links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1)
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1)
    }
    if (!settings.orphans) nodes = nodes.filter((n) => degree.has(n.id) || n.id === focus)
    return {
      nodes: nodes.map((n): GNode => ({ id: n.id, title: n.title, group: groupOf(n.path, depth), degree: degree.get(n.id) ?? 0 })),
      links: links.map((l) => ({ ...l })),
    }
  }, [raw, settings, focus])

  const neighbors = useMemo(() => {
    const m = new Map<number, Set<number>>()
    for (const l of data.links) {
      const a = idOf(l.source), b = idOf(l.target)
      if (!m.has(a)) m.set(a, new Set())
      if (!m.has(b)) m.set(b, new Set())
      m.get(a)!.add(b)
      m.get(b)!.add(a)
    }
    return m
  }, [data])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? new Set(data.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id)) : null
  }, [query, data])

  // Highlighted set: hovered node + neighbours, or search matches.
  const lit = useMemo(() => {
    if (hover !== null) return new Set([hover, ...(neighbors.get(hover) ?? [])])
    return matches
  }, [hover, neighbors, matches])

  const radius = (n: GNode) => (3 + Math.sqrt(n.degree) * 2.2) * settings.nodeSize

  useEffect(() => {
    const g = fg.current
    if (!g) return
    ;(g.d3Force('charge') as unknown as { strength: (v: number) => void } | undefined)?.strength(-settings.repel)
    ;(g.d3Force('link') as unknown as { distance: (v: number) => void } | undefined)?.distance(settings.distance)
    g.d3Force('collide', forceCollide<GNode>((n) => radius(n) + 6) as never)
    // weak gravity keeps unconnected notes close instead of drifting off-screen
    g.d3Force('x', forceX<GNode>(0).strength(0.05) as never)
    g.d3Force('y', forceY<GNode>(0).strength(0.05) as never)
    g.d3ReheatSimulation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.repel, settings.distance, settings.nodeSize, data])

  // Labels are drawn last, most important first, and skipped where they would overlap.
  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    const fontSize = 12 / scale
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`
    const placed: [number, number, number, number][] = []
    const priority = (n: GNode) =>
      (n.id === hover ? 1e6 : 0) + (n.id === focus ? 1e5 : 0) + (lit?.has(n.id) ? 1e4 : 0) + n.degree
    const nodes = [...data.nodes].sort((a, b) => priority(b) - priority(a))
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue
      const important = n.id === hover || n.id === focus || (lit?.has(n.id) ?? false)
      if (settings.labels === 'hover' && !important) continue
      if (settings.labels === 'auto' && !important && scale < 0.9 && n.degree < 3) continue
      if (lit && !lit.has(n.id) && settings.labels !== 'always') continue
      const text = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title
      const w = ctx.measureText(text).width
      const pad = 3 / scale
      const x = n.x - w / 2 - pad, y = n.y + radius(n) + 3 / scale, h = fontSize + pad * 1.4
      const overlaps = placed.some(([px, py, pw, ph]) => x < px + pw && x + w + 2 * pad > px && y < py + ph && y + h > py)
      if (overlaps && !important) continue
      placed.push([x, y, w + 2 * pad, h])
      ctx.globalAlpha = lit && !lit.has(n.id) ? 0.35 : 1
      ctx.fillStyle = theme.labelBg
      roundRect(ctx, x, y, w + 2 * pad, h, 3 / scale)
      ctx.fill()
      ctx.fillStyle = important ? theme.text : theme.label
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(text, n.x, y + pad * 0.7)
    }
    ctx.globalAlpha = 1
  }

  const focusTitle = focus !== undefined ? raw?.nodes.find((n) => n.id === focus)?.title : undefined
  const visibleGroups = groups.filter((g) => raw?.nodes.some((n) => groupOf(n.path, settings.colorDepth) === g.name))

  return (
    <div className="graph" ref={box}>
      <div className="graph-bar">
        <label className="graph-search">
          <Icon name="search" />
          <input placeholder="Im Graph suchen" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {focusTitle && (
          <span className="graph-focus">
            <Icon name="target" /> {focusTitle}
            <select value={settings.depth} onChange={(e) => set('depth', Number(e.target.value))} title="Tiefe">
              {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d} {d === 1 ? 'Schritt' : 'Schritte'}</option>)}
            </select>
            <button className="icon-btn" title="Ganzen Graph zeigen" onClick={() => onFocus(undefined)}><Icon name="x" /></button>
          </span>
        )}
        <span className="spacer" />
        <button className={`btn ghost ${panel ? 'on' : ''}`} onClick={() => setPanel((p) => !p)}>
          <Icon name="sliders" /> Anzeige
        </button>
      </div>

      {panel && (
        <div className="graph-panel">
          <section>
            <h5>Filter</h5>
            <Toggle label="Verlinkungen" on={settings.links} set={(v) => set('links', v)} />
            <Toggle label="Unterseiten" on={settings.subpages} set={(v) => set('subpages', v)} />
            <Toggle label="Ähnlicher Inhalt" on={settings.semantic} set={(v) => set('semantic', v)} />
            {settings.semantic && (
              <Slider label="Mindest-Ähnlichkeit" value={settings.minSimilarity} min={0} max={0.95} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} set={(v) => set('minSimilarity', v)} />
            )}
            <Toggle label="Notizen ohne Verbindung" on={settings.orphans} set={(v) => set('orphans', v)} />
          </section>
          <section>
            <h5>Darstellung</h5>
            <Toggle label="Farben nach Ordner" on={settings.colorByFolder} set={(v) => set('colorByFolder', v)} />
            {settings.colorByFolder && (
              <label className="gp-row">
                Ordner-Ebene
                <select value={settings.colorDepth} onChange={(e) => set('colorDepth', Number(e.target.value) as 1 | 2)}>
                  <option value={1}>oberste</option>
                  <option value={2}>Unterordner</option>
                </select>
              </label>
            )}
            <Toggle label="Pfeile" on={settings.arrows} set={(v) => set('arrows', v)} />
            <label className="gp-row">
              Beschriftung
              <select value={settings.labels} onChange={(e) => set('labels', e.target.value as Settings['labels'])}>
                <option value="auto">automatisch</option>
                <option value="always">immer</option>
                <option value="hover">beim Zeigen</option>
              </select>
            </label>
            <Slider label="Knotengröße" value={settings.nodeSize} min={0.5} max={2} step={0.1} fmt={(v) => `${v.toFixed(1)}×`} set={(v) => set('nodeSize', v)} />
          </section>
          <section>
            <h5>Kräfte</h5>
            <Slider label="Abstoßung" value={settings.repel} min={20} max={500} step={10} fmt={String} set={(v) => set('repel', v)} />
            <Slider label="Linklänge" value={settings.distance} min={15} max={200} step={5} fmt={String} set={(v) => set('distance', v)} />
          </section>
          <button className="btn ghost" onClick={() => setSettings(DEFAULTS)}>Zurücksetzen</button>
        </div>
      )}

      {settings.colorByFolder && visibleGroups.length > 1 && (
        <div className="graph-legend">
          {visibleGroups.map((g) => {
            const off = settings.hiddenGroups.includes(g.name)
            return (
              <button
                key={g.name}
                className={off ? 'off' : ''}
                title={off ? 'Einblenden' : 'Ausblenden'}
                onClick={() => set('hiddenGroups', off ? settings.hiddenGroups.filter((x) => x !== g.name) : [...settings.hiddenGroups, g.name])}
              >
                <i style={{ background: g.color }} /> {g.name}
              </button>
            )
          })}
        </div>
      )}

      <ForceGraph2D<GNode, GLink>
        ref={fg}
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor={theme.bg}
        nodeId="id"
        nodeLabel={() => ''}
        cooldownTicks={120}
        onEngineStop={() => {
          if (fitted.current) return
          fitted.current = true
          fg.current?.zoomToFit(400, 90)
          // few nodes would otherwise be blown up to fill the screen
          setTimeout(() => {
            const z = fg.current?.zoom() ?? 1
            if (z > 2.2) fg.current?.zoom(2.2, 300)
          }, 450)
        }}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = radius(n)
          const dim = lit !== null && !lit.has(n.id)
          ctx.globalAlpha = dim ? 0.18 : 1
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2)
          ctx.fillStyle = settings.colorByFolder ? colorOf.get(n.group) ?? theme.neutral : theme.node
          ctx.fill()
          ctx.lineWidth = 1.5 / scale
          ctx.strokeStyle = theme.bg
          ctx.stroke()
          if (n.id === hover || n.id === focus || (matches?.has(n.id) && hover === null)) {
            ctx.lineWidth = 2 / scale
            ctx.strokeStyle = theme.text
            ctx.beginPath()
            ctx.arc(n.x!, n.y!, r + 3 / scale, 0, Math.PI * 2)
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, radius(n) + 4, 0, Math.PI * 2)
          ctx.fill()
        }}
        onRenderFramePost={drawLabels}
        linkColor={(l) => {
          const on = lit === null || (lit.has(idOf(l.source)) && lit.has(idOf(l.target)))
          const base = l.kind === 'semantic' ? theme.semantic : l.kind === 'child' ? theme.neutral : theme.link
          return on ? base : theme.faint
        }}
        linkWidth={(l) => (l.kind === 'semantic' ? 0.6 + 2.4 * Math.max(0, l.weight - 0.3) : l.kind === 'child' ? 0.8 : 1.1)}
        linkLineDash={(l) => (l.kind === 'semantic' ? [3, 3] : l.kind === 'child' ? [1, 2.5] : null)}
        linkCurvature={0.08}
        linkDirectionalArrowLength={(l) => (settings.arrows && l.kind === 'link' ? 4 : 0)}
        linkDirectionalArrowRelPos={1}
        onNodeHover={(n) => setHover(n ? n.id : null)}
        onNodeClick={(n, e) => (e.shiftKey || e.altKey ? onFocus(n.id) : onOpen(n.id))}
        onNodeRightClick={(n) => onFocus(n.id)}
        onBackgroundClick={() => setQuery('')}
      />
      <div className="graph-hint">Klick öffnet · Shift-Klick oder Rechtsklick zeigt die Umgebung</div>
    </div>
  )
}

/** Folder a note belongs to for colouring: top level, or top level + one subfolder. */
function groupOf(path: string, depth: 1 | 2 = 1) {
  const parts = path.split('/').slice(0, -1)
  return parts.length ? parts.slice(0, depth).join(' / ') : ROOT_GROUP
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="gp-row">
      {label}
      <input type="checkbox" className="switch" checked={on} onChange={(e) => set(e.target.checked)} />
    </label>
  )
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; set: (v: number) => void }) {
  return (
    <label className="gp-row col">
      <span>
        {p.label} <b>{p.fmt(p.value)}</b>
      </span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.set(Number(e.target.value))} />
    </label>
  )
}

/** Graph colours follow the CSS theme (light/dark). */
function useTheme() {
  const read = () => {
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    return {
      bg: v('--bg'),
      text: v('--text'),
      node: v('--text-2'),
      neutral: v('--muted'),
      link: v('--graph-link'),
      faint: v('--graph-faint'),
      semantic: v('--amber'),
      label: v('--text-2'),
      labelBg: v('--graph-label-bg'),
      series: Array.from({ length: MAX_HUES }, (_, i) => v(`--series-${i + 1}`)),
    }
  }
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setTheme(read())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return theme
}

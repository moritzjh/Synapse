import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { forceCollide, forceX, forceY } from 'd3-force'
import { api, type GraphData } from '../api'
import { Icon } from './Icons'
import GraphPanel from './graph/GraphPanel'
import { loadSettings, matchesGroup, palette, saveSettings, type Palette, type Settings } from './graph/settings'

interface GNode {
  id: number
  title: string
  group: string
  color: string
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

const ROOT_GROUP = 'Ohne Ordner'
const idOf = (v: number | GNode) => (typeof v === 'object' ? v.id : v)

/** Folder a note belongs to for colouring: top level, or top level + one subfolder. */
function folderOf(path: string, depth: 1 | 2) {
  const parts = path.split('/').slice(0, -1)
  return parts.length ? parts.slice(0, depth).join(' / ') : ROOT_GROUP
}

function withAlpha(color: string, a: number) {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  return color
}

// a fixed star field (positions in 0..1) so it doesn't jump between frames
const STARS = Array.from({ length: 220 }, (_, i) => {
  const r = (k: number) => {
    const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  return { x: r(1), y: r(2), s: 0.4 + r(3) * 1.3, p: r(4) * Math.PI * 2, d: 0.02 + r(5) * 0.06 }
})

export default function GraphView({ focus, onOpen, onFocus }: { focus?: number; onOpen: (id: number) => void; onFocus: (id?: number) => void }) {
  const [raw, setRaw] = useState<GraphData | null>(null)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [panel, setPanel] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const [reveal, setReveal] = useState<number | null>(null) // time-lapse: number of notes shown
  const box = useRef<HTMLDivElement>(null)
  const fg = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const fitted = useRef(false)
  const alpha = useRef(new Map<number, number>()) // animated per-node emphasis 0..1
  const prevNodes = useRef<GNode[]>([])
  const cssTheme = useCssTheme()
  const pal: Palette = useMemo(() => palette(settings.style, () => getComputedStyle(document.documentElement)), [settings.style, cssTheme])

  useEffect(() => {
    api.graph().then(setRaw)
  }, [])
  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  const set = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v })), [])

  // ---- groups & colours --------------------------------------------------------------

  // "Auto": colour by subfolder when most notes live in one top-level folder (e.g. everything under "Uni").
  const depth: 1 | 2 = useMemo(() => {
    if (settings.colorDepth !== 0) return settings.colorDepth
    const nodes = raw?.nodes ?? []
    const counts = new Map<string, number>()
    for (const n of nodes) counts.set(folderOf(n.path, 1), (counts.get(folderOf(n.path, 1)) ?? 0) + 1)
    const top = Math.max(0, ...counts.values())
    return nodes.length && top / nodes.length > 0.55 ? 2 : 1
  }, [raw, settings.colorDepth])

  const folders = useMemo(
    () =>
      [...new Set((raw?.nodes ?? []).map((n) => folderOf(n.path, depth)))].sort((a, b) =>
        a === ROOT_GROUP ? 1 : b === ROOT_GROUP ? -1 : a.localeCompare(b, 'de'),
      ),
    [raw, depth],
  )

  const classify = useCallback(
    (title: string, path: string): { group: string; color: string } => {
      for (const g of settings.groups)
        if (matchesGroup(g, title, path)) return { group: g.query.trim(), color: pal.series[g.color % 8] }
      if (settings.autoGroups) {
        const f = folderOf(path, depth)
        const i = folders.indexOf(f)
        return { group: f, color: f === ROOT_GROUP || i >= 8 ? pal.neutral : pal.series[i] }
      }
      return { group: 'Notizen', color: pal.neutral }
    },
    [settings.groups, settings.autoGroups, depth, folders, pal],
  )

  // ---- data -----------------------------------------------------------------------------

  const order = useMemo(
    () => [...(raw?.nodes ?? [])].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id).map((n) => n.id),
    [raw],
  )

  const data = useMemo(() => {
    if (!raw) return { nodes: [] as GNode[], links: [] as GLink[] }
    const s = settings
    const hidden = new Set(s.hiddenGroups)
    const shownByTime = reveal !== null ? new Set(order.slice(0, reveal)) : null
    let nodes = raw.nodes
      .map((n) => ({ ...n, ...classify(n.title, n.path) }))
      .filter((n) => !hidden.has(n.group) && (!shownByTime || shownByTime.has(n.id)))
    let ids = new Set(nodes.map((n) => n.id))

    // subpages: "A/B.md" is the parent of everything in "A/B/"
    const byKey = new Map(raw.nodes.map((n) => [n.path.replace(/\.md$/, ''), n.id]))
    const child = s.subpages
      ? raw.nodes.flatMap((n) => {
          const key = n.path.replace(/\.md$/, '')
          const parent = key.includes('/') ? byKey.get(key.slice(0, key.lastIndexOf('/'))) : undefined
          return parent !== undefined ? [{ source: parent, target: n.id, kind: 'child' as const, weight: 1 }] : []
        })
      : []
    let links = [...raw.edges, ...child].filter(
      (e) =>
        ids.has(e.source) &&
        ids.has(e.target) &&
        (e.kind === 'child' || (e.kind === 'link' ? s.links : s.semantic && e.weight >= s.minSimilarity)),
    )

    if (focus !== undefined && ids.has(focus)) {
      const adj = new Map<number, number[]>()
      for (const l of links) {
        adj.set(l.source, [...(adj.get(l.source) ?? []), l.target])
        adj.set(l.target, [...(adj.get(l.target) ?? []), l.source])
      }
      const keep = new Set([focus])
      let frontier = [focus]
      for (let d = 0; d < s.depth; d++) {
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
    if (!s.orphans) nodes = nodes.filter((n) => degree.has(n.id) || n.id === focus)

    // keep positions of nodes that already exist (time-lapse adds nodes without reshuffling)
    const prev = new Map(prevNodes.current.map((n) => [n.id, n]))
    const out = {
      nodes: nodes.map((n): GNode => {
        const p = prev.get(n.id)
        return { id: n.id, title: n.title.trim() || 'Ohne Titel', group: n.group, color: n.color, degree: degree.get(n.id) ?? 0, x: p?.x, y: p?.y }
      }),
      links: links.map((l) => ({ ...l })),
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, settings.hiddenGroups, settings.subpages, settings.links, settings.semantic, settings.minSimilarity, settings.orphans, settings.depth, focus, classify, reveal, order])
  prevNodes.current = data.nodes

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

  const lit = useMemo(() => (hover !== null ? new Set([hover, ...(neighbors.get(hover) ?? [])]) : matches), [hover, neighbors, matches])
  const litRef = useRef(lit)
  litRef.current = lit

  const radius = (n: GNode) => (3 + Math.sqrt(n.degree) * 1.45) * settings.nodeSize

  // ---- forces -----------------------------------------------------------------------------

  useEffect(() => {
    const g = fg.current
    if (!g) return
    const charge = g.d3Force('charge') as unknown as { strength: (v: number) => void; distanceMax: (v: number) => void } | undefined
    charge?.strength(-settings.repel)
    charge?.distanceMax(600)
    const link = g.d3Force('link') as unknown as { distance: (v: number) => void; strength: (v: number) => void } | undefined
    link?.distance(settings.distance)
    link?.strength(settings.linkForce)
    g.d3Force('collide', forceCollide<GNode>((n) => radius(n) + 4) as never)
    g.d3Force('x', forceX<GNode>(0).strength(settings.center) as never)
    g.d3Force('y', forceY<GNode>(0).strength(settings.center) as never)
    g.d3ReheatSimulation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.repel, settings.distance, settings.linkForce, settings.center, settings.nodeSize, data])

  // ---- time-lapse (Obsidian's "Animate") -------------------------------------------------------

  const animate = () => {
    if (!raw) return
    const total = order.length
    let n = 0
    setReveal(0)
    const step = Math.max(1, Math.ceil(total / 90))
    const t = setInterval(() => {
      n += step
      if (n >= total) {
        clearInterval(t)
        setReveal(null)
      } else setReveal(n)
    }, 55)
  }

  // ---- drawing ------------------------------------------------------------------------------

  // eased emphasis per node: 1 = highlighted/normal, 0.12 = dimmed
  const emphasis = (id: number) => {
    const target = lit === null || lit.has(id) ? 1 : 0.12
    const cur = alpha.current.get(id) ?? target
    const next = cur + (target - cur) * 0.18
    alpha.current.set(id, Math.abs(next - target) < 0.005 ? target : next)
    return next
  }

  const drawBackground = (ctx: CanvasRenderingContext2D, scale: number) => {
    const t = ctx.getTransform()
    const W = ctx.canvas.width, H = ctx.canvas.height
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (pal.bg2) {
      const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H / 2, Math.max(W, H) * 0.75)
      g.addColorStop(0, pal.bg)
      g.addColorStop(1, pal.bg2)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }
    if (settings.background === 'stars') {
      const now = performance.now() / 1000
      for (const st of STARS) {
        // slow parallax with panning
        const x = (((st.x * W + t.e * st.d) % W) + W) % W
        const y = (((st.y * H + t.f * st.d) % H) + H) % H
        ctx.globalAlpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(now * 0.8 + st.p))
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(x, y, st.s * (ctx.canvas.width / size.w), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
    if (settings.background === 'dots') {
      // grid in graph space, so it pans and zooms with the notes
      let step = 32
      while (step * scale < 14) step *= 2
      const inv = t.inverse()
      const tl = inv.transformPoint({ x: 0, y: 0 }), br = inv.transformPoint({ x: W, y: H })
      ctx.fillStyle = settings.style === 'clean' ? pal.grid : 'rgba(255,255,255,0.09)'
      const r = 1.1 / scale
      for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step)
        for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
    }
  }

  // Labels: text with a soft halo in the background colour (no boxes), most important first,
  // skipped where they would collide.
  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    const threshold = 0.3 + settings.textFade * 2
    const zoomFade = Math.max(0, Math.min(1, (scale - threshold) / 0.5))
    const placed: [number, number, number, number][] = []
    const priority = (n: GNode) => (n.id === hover ? 1e6 : 0) + (n.id === focus ? 1e5 : 0) + (lit?.has(n.id) ? 1e4 : 0) + n.degree
    for (const n of [...data.nodes].sort((a, b) => priority(b) - priority(a))) {
      if (n.x === undefined || n.y === undefined) continue
      const important = n.id === hover || n.id === focus || (lit?.has(n.id) ?? false)
      const hub = n.degree >= 5
      let a = 1
      if (settings.labels === 'hover') a = important ? 1 : 0
      else if (settings.labels === 'auto') a = important ? 1 : Math.max(zoomFade, hub ? 0.9 : n.degree >= 3 ? zoomFade * 0.5 + 0.35 : 0)
      a *= alpha.current.get(n.id) ?? 1
      if (lit && !lit.has(n.id)) a *= 0.5
      if (a < 0.04) continue
      const size = (hub || important ? 12.5 : 11) / scale
      ctx.font = `${hub || important ? 600 : 500} ${size}px Inter, system-ui, sans-serif`
      const text = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title
      const w = ctx.measureText(text).width
      const gapY = 5 / scale
      const x = n.x - w / 2, y = n.y + radius(n) * (n.id === hover ? 1.25 : 1) + gapY, h = size * 1.2
      if (placed.some(([px, py, pw, ph]) => x < px + pw && x + w > px && y < py + ph && y + h > py) && !important) continue
      placed.push([x - 2 / scale, y, w + 4 / scale, h])
      ctx.globalAlpha = a
      ctx.lineWidth = 4 / scale
      ctx.strokeStyle = pal.labelHalo
      ctx.strokeText(text, n.x, y)
      ctx.fillStyle = important || hub ? pal.text : pal.label
      ctx.fillText(text, n.x, y)
    }
    ctx.globalAlpha = 1
  }

  const linkTouches = (l: GLink, id: number | null) => id !== null && (idOf(l.source) === id || idOf(l.target) === id)

  const focusTitle = focus !== undefined ? raw?.nodes.find((n) => n.id === focus)?.title : undefined
  const legend = useMemo(() => {
    const seen = new Map<string, string>()
    for (const n of raw?.nodes ?? []) {
      const c = classify(n.title, n.path)
      if (!seen.has(c.group)) seen.set(c.group, c.color)
    }
    return [...seen.entries()]
  }, [raw, classify])

  const dark = settings.style !== 'clean'

  return (
    <div className={`graph ${dark ? 'graph-dark' : ''}`} ref={box} style={{ background: pal.bg2 ?? pal.bg }}>
      <div className="graph-bar">
        <label className="graph-search">
          <Icon name="search" />
          <input placeholder="Im Graph suchen" value={query} onChange={(e) => setQuery(e.target.value)} />
          {matches && <span className="graph-count">{matches.size}</span>}
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
        <span className="graph-actions">
          <button className="icon-btn" title="Zeitraffer: Notizen in der Reihenfolge ihrer Entstehung" onClick={animate} disabled={reveal !== null}>
            <Icon name="play" />
          </button>
          <button className="icon-btn" title="Alles zeigen" onClick={() => fg.current?.zoomToFit(500, 90)}>
            <Icon name="fit" />
          </button>
          <button className={`icon-btn ${panel ? 'on' : ''}`} title="Graph-Einstellungen" onClick={() => setPanel((p) => !p)}>
            <Icon name="sliders" />
          </button>
        </span>
      </div>

      {panel && (
        <GraphPanel settings={settings} series={pal.series} set={set} replace={setSettings} onClose={() => setPanel(false)} />
      )}

      {legend.length > 1 && (
        <div className="graph-legend">
          {legend.map(([name, color]) => {
            const off = settings.hiddenGroups.includes(name)
            return (
              <button
                key={name}
                className={off ? 'off' : ''}
                title={off ? 'Einblenden' : 'Ausblenden'}
                onClick={() => set('hiddenGroups', off ? settings.hiddenGroups.filter((x) => x !== name) : [...settings.hiddenGroups, name])}
              >
                <i style={{ background: color, boxShadow: settings.glow > 0 ? `0 0 6px ${color}` : 'none' }} /> {name}
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
        backgroundColor={pal.bg2 ? 'rgba(0,0,0,0)' : pal.bg}
        autoPauseRedraw={false}
        nodeId="id"
        nodeLabel={() => ''}
        cooldownTicks={reveal !== null ? 30 : 140}
        d3VelocityDecay={0.32}
        onEngineStop={() => {
          if (fitted.current) return
          fitted.current = true
          fg.current?.zoomToFit(400, 90)
          setTimeout(() => {
            const z = fg.current?.zoom() ?? 1
            if (z > 2.2) fg.current?.zoom(2.2, 300)
          }, 450)
        }}
        onRenderFramePre={drawBackground}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = radius(n)
          const e = emphasis(n.id)
          const isHover = n.id === hover
          const highlighted = isHover || n.id === focus || (matches?.has(n.id) && hover === null)
          const rr = r * (isHover ? 1.25 : 1)
          ctx.globalAlpha = e
          // soft aura, a little stronger on hover
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, rr + (isHover ? 7 : 3.5) / Math.max(scale, 0.6), 0, Math.PI * 2)
          ctx.fillStyle = withAlpha(n.color, isHover ? 0.22 : 0.13)
          ctx.fill()
          if (settings.glow > 0) {
            ctx.shadowColor = n.color
            ctx.shadowBlur = (4 + 22 * settings.glow) * (isHover ? 1.6 : 1)
          }
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, rr, 0, Math.PI * 2)
          ctx.fillStyle = n.color
          ctx.fill()
          ctx.shadowBlur = 0
          ctx.lineWidth = 1.2 / scale
          ctx.strokeStyle = pal.labelHalo
          ctx.stroke()
          if (highlighted) {
            ctx.lineWidth = 1.6 / scale
            ctx.strokeStyle = pal.accent
            ctx.beginPath()
            ctx.arc(n.x!, n.y!, rr + 3.5 / scale, 0, Math.PI * 2)
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, radius(n) + 5, 0, Math.PI * 2)
          ctx.fill()
        }}
        onRenderFramePost={drawLabels}
        linkColor={(l) => {
          const a = Math.min(alpha.current.get(idOf(l.source)) ?? 1, alpha.current.get(idOf(l.target)) ?? 1)
          if (hover !== null && linkTouches(l, hover)) return pal.accent
          const src = typeof l.source === 'object' ? l.source : null
          const base =
            l.kind === 'semantic' ? pal.semantic : l.kind === 'child' ? withAlpha(pal.neutral, 0.45) : pal.tintLinks && src ? withAlpha(src.color, 0.38) : pal.link
          return a < 0.5 ? pal.faint : base
        }}
        linkWidth={(l) =>
          settings.linkWidth *
          (hover !== null && linkTouches(l, hover) ? 1.8 : l.kind === 'semantic' ? 0.6 + 2 * Math.max(0, l.weight - 0.3) : l.kind === 'child' ? 0.7 : 1)
        }
        linkLineDash={(l) => (l.kind === 'semantic' ? [2, 3] : l.kind === 'child' ? [1, 2.5] : null)}
        linkCurvature={0.06}
        linkDirectionalArrowLength={(l) => (settings.arrows && l.kind === 'link' ? 3.5 * settings.linkWidth : 0)}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => pal.label}
        linkDirectionalParticles={(l) => (settings.particles && linkTouches(l, hover) ? 3 : 0)}
        linkDirectionalParticleWidth={2.4}
        linkDirectionalParticleSpeed={0.008}
        linkDirectionalParticleColor={() => pal.accent}
        onNodeHover={(n) => setHover(n ? n.id : null)}
        onNodeClick={(n, e) => (e.shiftKey || e.altKey ? onFocus(n.id) : onOpen(n.id))}
        onNodeRightClick={(n) => onFocus(n.id)}
        onNodeDragEnd={(n) => {
          // pin dragged notes where they were dropped, like Obsidian
          ;(n as GNode & { fx?: number; fy?: number }).fx = n.x
          ;(n as GNode & { fx?: number; fy?: number }).fy = n.y
        }}
        onBackgroundClick={() => setQuery('')}
      />
      {reveal !== null && <div className="graph-timelapse">{reveal} / {order.length} Notizen</div>}
      <div className="graph-hint">Klick öffnet · Rechtsklick zeigt die Umgebung · Ziehen pinnt</div>
    </div>
  )
}

/** Re-render when the app's light/dark theme changes. */
function useCssTheme() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

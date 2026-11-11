import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { forceCollide, forceX, forceY } from 'd3-force'
import { api, cardApi, type GraphData, type NoteMastery } from '../api'
import { Icon } from './Icons'
import GraphPanel from './graph/GraphPanel'
import { locale, t } from '../i18n'
import { hull, loadSettings, matchesGroup, mix, palette, saveSettings, withAlpha, type Palette, type Settings, type Status } from './graph/settings'

interface GNode {
  id: number
  title: string
  path: string
  group: string
  color: string
  degree: number
  status: Status
  cards: number
  x?: number
  y?: number
  vx?: number
  vy?: number
}

interface GLink {
  source: number | GNode
  target: number | GNode
  kind: 'link' | 'semantic' | 'child'
  weight: number
}

// Group names are identifiers (stored in settings.hiddenGroups) – translate only for display.
const ROOT_GROUP = 'Ohne Ordner'
const NOTES_GROUP = 'Notizen'
const groupLabel = (g: string) => (g === ROOT_GROUP || g === NOTES_GROUP ? t(g) : g)
const idOf = (v: number | GNode) => (typeof v === 'object' ? v.id : v)
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'

const STATUS_ORDER: Status[] = ['strong', 'fading', 'weak', 'new', 'none']
const STATUS_LABEL: Record<Status, string> = {
  strong: t('Sitzt'),
  fading: t('Lässt nach'),
  weak: t('Fast vergessen'),
  new: t('Noch nicht gelernt'),
  none: t('Keine Karten'),
}

/** Mean recall probability of a note's studied cards → a status. */
function statusOf(m: NoteMastery | undefined): Status {
  if (!m || !m.cards) return 'none'
  if (m.new === m.cards) return 'new'
  return m.retention >= 0.9 ? 'strong' : m.retention >= 0.75 ? 'fading' : 'weak'
}

/** Folder a note belongs to for colouring: top level, or top level + one subfolder. */
function folderOf(path: string, depth: 1 | 2) {
  const parts = path.split('/').slice(0, -1)
  return parts.length ? parts.slice(0, depth).join(' / ') : ROOT_GROUP
}

interface Props {
  focus?: number
  onOpen: (id: number) => void
  onFocus: (id?: number) => void
  onStudy: (path: string, name: string) => void
}

export default function GraphView({ focus, onOpen, onFocus, onStudy }: Props) {
  const [raw, setRaw] = useState<GraphData | null>(null)
  const [mastery, setMastery] = useState<Map<number, NoteMastery>>(new Map())
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [panel, setPanel] = useState(false)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const [reveal, setReveal] = useState<number | null>(null) // time-lapse: number of notes shown
  const box = useRef<HTMLDivElement>(null)
  const fg = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const fitted = useRef(false)
  const alpha = useRef(new Map<number, number>()) // animated per-node emphasis 0..1
  const prevNodes = useRef<GNode[]>([])
  const cssTheme = useCssTheme()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pal: Palette = useMemo(() => palette(getComputedStyle(document.documentElement)), [cssTheme])
  const byMastery = settings.view === 'mastery'

  useEffect(() => {
    api.graph().then(setRaw)
    cardApi.mastery().then((rows) => setMastery(new Map(rows.map((r) => [r.note_id, r])))).catch(() => {})
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
        a === ROOT_GROUP ? 1 : b === ROOT_GROUP ? -1 : a.localeCompare(b, locale),
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
        return { group: f, color: f === ROOT_GROUP || i >= 8 ? pal.muted : pal.series[i] }
      }
      return { group: NOTES_GROUP, color: pal.muted }
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
    return {
      nodes: nodes.map((n): GNode => {
        const p = prev.get(n.id)
        const m = mastery.get(n.id)
        return {
          id: n.id,
          title: n.title.trim() || t('Ohne Titel'),
          path: n.path,
          group: n.group,
          color: n.color,
          degree: degree.get(n.id) ?? 0,
          status: statusOf(m),
          cards: m?.cards ?? 0,
          x: p?.x,
          y: p?.y,
        }
      }),
      links: links.map((l) => ({ ...l })),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, mastery, settings.hiddenGroups, settings.subpages, settings.links, settings.semantic, settings.minSimilarity, settings.orphans, settings.depth, focus, classify, reveal, order])
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

  // Folder view: size = how connected a note is. Knowledge view: size = how many cards it holds.
  const radius = (n: GNode) =>
    Math.min(13, byMastery ? (n.cards ? 3.2 + Math.sqrt(n.cards) * 1.25 : 2.4) : 2.8 + Math.sqrt(n.degree) * 1.5) * settings.nodeSize

  // ---- forces -----------------------------------------------------------------------------

  useEffect(() => {
    const g = fg.current
    if (!g) return
    const charge = g.d3Force('charge') as unknown as { strength: (v: number) => void; distanceMax: (v: number) => void } | undefined
    charge?.strength(-settings.repel)
    charge?.distanceMax(520)
    const link = g.d3Force('link') as unknown as { distance: (v: number) => void; strength: (v: number) => void } | undefined
    link?.distance(settings.distance)
    link?.strength(settings.linkForce)
    g.d3Force('collide', forceCollide<GNode>((n) => radius(n) + 7) as never)
    g.d3Force('x', forceX<GNode>(0).strength(settings.center) as never)
    g.d3Force('y', forceY<GNode>(0).strength(settings.center) as never)
    // Notes of one group drift towards their common centre, so regions stay in one piece.
    let nodes: GNode[] = []
    const cluster = Object.assign(
      (a: number) => {
        const c = new Map<string, [number, number, number]>()
        for (const n of nodes) {
          const e = c.get(n.group) ?? [0, 0, 0]
          c.set(n.group, [e[0] + (n.x ?? 0), e[1] + (n.y ?? 0), e[2] + 1])
        }
        for (const n of nodes) {
          const [sx, sy, k] = c.get(n.group)!
          if (k < 2) continue
          n.vx = (n.vx ?? 0) + (sx / k - (n.x ?? 0)) * 0.16 * a
          n.vy = (n.vy ?? 0) + (sy / k - (n.y ?? 0)) * 0.16 * a
        }
      },
      { initialize: (ns: GNode[]) => (nodes = ns) },
    )
    g.d3Force('cluster', settings.regions ? (cluster as never) : null)
    g.d3ReheatSimulation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.repel, settings.distance, settings.linkForce, settings.center, settings.nodeSize, settings.regions, byMastery, data])

  // ---- time-lapse (Obsidian's "Animate") -------------------------------------------------------

  const animate = () => {
    if (!raw) return
    const total = order.length
    let n = 0
    setReveal(0)
    const step = Math.max(1, Math.ceil(total / 90))
    const timer = setInterval(() => {
      n += step
      if (n >= total) {
        clearInterval(timer)
        setReveal(null)
      } else setReveal(n)
    }, 55)
  }

  // ---- drawing ------------------------------------------------------------------------------

  // eased emphasis per node: 1 = highlighted/normal, 0.14 = dimmed
  const emphasis = (id: number) => {
    const target = lit === null || lit.has(id) ? 1 : 0.14
    const cur = alpha.current.get(id) ?? target
    const next = cur + (target - cur) * 0.2
    alpha.current.set(id, Math.abs(next - target) < 0.005 ? target : next)
    return next
  }

  const nodeColor = (n: GNode) => (byMastery ? (n.status === 'strong' || n.status === 'fading' || n.status === 'weak' ? pal.status[n.status] : pal.muted) : n.color)

  // Regions: one tinted, rounded area per group with its name as a caption – the notes sit on it like places on a map.
  const drawRegions = (ctx: CanvasRenderingContext2D, scale: number) => {
    if (!settings.regions) return
    const groups = new Map<string, GNode[]>()
    for (const n of data.nodes) {
      if (n.x === undefined || n.y === undefined) continue
      if (n.group === NOTES_GROUP || n.group === ROOT_GROUP) continue
      groups.set(n.group, [...(groups.get(n.group) ?? []), n])
    }
    const dim = lit !== null
    const pad = 26
    const regions = [...groups.entries()]
      .filter(([, ns]) => ns.length >= 2)
      .map(([name, ns]) => {
        const pts = hull(ns.map((n) => [n.x!, n.y!]))
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
        return { name, color: ns[0].color, pts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
      })
      // large areas first, so small ones lie on top
      .sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY))

    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    for (const r of regions) {
      // opaque tint (not alpha), so the padded outline and the fill don't add up
      const tint = mix(pal.bg, byMastery ? pal.muted : r.color, byMastery ? 0.07 : 0.085)
      ctx.beginPath()
      r.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.closePath()
      ctx.fillStyle = tint
      ctx.strokeStyle = tint
      ctx.lineWidth = pad * 2
      ctx.globalAlpha = dim ? 0.55 : 1
      ctx.stroke()
      ctx.fill()
    }
    // captions on top of all areas
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    const fontSize = Math.min(13, Math.max(9.5, 10.5 / Math.sqrt(scale))) / scale
    ctx.font = `600 ${fontSize}px ${FONT}`
    const spaced = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
    if ('letterSpacing' in spaced) spaced.letterSpacing = `${fontSize * 0.09}px`
    for (const r of regions) {
      const label = groupLabel(r.name).split(' / ').pop()!.toUpperCase()
      ctx.globalAlpha = dim ? 0.35 : 0.9
      ctx.fillStyle = mix(pal.muted, byMastery ? pal.muted : r.color, 0.55)
      ctx.fillText(label, (r.minX + r.maxX) / 2, r.minY - pad + fontSize * 1.9)
    }
    if ('letterSpacing' in spaced) spaced.letterSpacing = '0px'
    ctx.globalAlpha = 1
  }

  // Labels sit beside their note like place names on a map: hubs larger and darker, the rest small and quiet.
  // A label that would cover a note or another label tries the other side, then below, then is left out.
  const drawLabels = (ctx: CanvasRenderingContext2D, scale: number) => {
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    const threshold = 0.3 + settings.textFade * 2
    const zoomFade = Math.max(0, Math.min(1, (scale - threshold) / 0.5))
    const placed: [number, number, number, number][] = []
    for (const n of data.nodes) {
      if (n.x === undefined || n.y === undefined) continue
      const r = radius(n) + 1.5 / scale
      placed.push([n.x - r, n.y - r, 2 * r, 2 * r])
    }
    const hits = (x: number, y: number, w: number, h: number, own: number) =>
      placed.some(([px, py, pw, ph], i) => i !== own && x < px + pw && x + w > px && y < py + ph && y + h > py)
    const priority = (n: GNode) => (n.id === hover ? 1e6 : 0) + (n.id === focus ? 1e5 : 0) + (lit?.has(n.id) ? 1e4 : 0) + (byMastery ? n.cards : n.degree)
    const index = new Map(data.nodes.map((n, i) => [n.id, i]))
    for (const n of [...data.nodes].sort((a, b) => priority(b) - priority(a))) {
      if (n.x === undefined || n.y === undefined) continue
      const important = n.id === hover || n.id === focus || (lit?.has(n.id) ?? false)
      const hub = byMastery ? n.cards >= 6 : n.degree >= 5
      let a = 1
      if (settings.labels === 'hover') a = important ? 1 : 0
      else if (settings.labels === 'auto') a = important ? 1 : Math.max(zoomFade, hub ? 0.92 : n.degree >= 3 ? zoomFade * 0.5 + 0.4 : 0)
      a *= alpha.current.get(n.id) ?? 1
      if (a < 0.05) continue
      const strong = hub || n.id === hover || n.id === focus
      const fs = (strong ? 12.5 : 11.5) / scale
      ctx.font = `${strong ? 600 : 450} ${fs}px ${FONT}`
      const text = n.title.length > 30 ? n.title.slice(0, 29) + '…' : n.title
      const w = ctx.measureText(text).width
      const h = fs * 1.25
      const r = radius(n)
      const gap = (n.id === hover || n.id === focus ? 9 : 5) / scale
      const own = index.get(n.id)!
      const spots: [number, number, CanvasTextAlign][] = [
        [n.x + r + gap, n.y, 'left'],
        [n.x - r - gap, n.y, 'right'],
        [n.x, n.y + r + gap + h / 2, 'center'],
        [n.x, n.y - r - gap - h / 2, 'center'],
      ]
      const spot = spots.find(([x, y, align]) => !hits(align === 'left' ? x : align === 'right' ? x - w : x - w / 2, y - h / 2, w, h, own)) ?? (important ? spots[0] : null)
      if (!spot) continue
      const [x, y, align] = spot
      placed.push([align === 'left' ? x : align === 'right' ? x - w : x - w / 2, y - h / 2, w, h])
      ctx.textAlign = align
      ctx.globalAlpha = a
      ctx.lineWidth = 3.5 / scale
      ctx.strokeStyle = pal.bg
      ctx.strokeText(text, x, y)
      ctx.fillStyle = strong ? pal.text : pal.label
      ctx.fillText(text, x, y)
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
  const statusCounts = useMemo(() => {
    const c = new Map<Status, number>()
    for (const n of data.nodes) c.set(n.status, (c.get(n.status) ?? 0) + 1)
    return c
  }, [data])

  const hovered = hover !== null ? data.nodes.find((n) => n.id === hover) : undefined
  const hoveredMastery = hovered ? mastery.get(hovered.id) : undefined

  return (
    <div className="graph" ref={box}>
      <div className="graph-bar">
        <label className="graph-search">
          <Icon name="search" />
          <input placeholder={t('Im Graph suchen')} value={query} onChange={(e) => setQuery(e.target.value)} />
          {matches && <span className="graph-count">{matches.size}</span>}
        </label>
        <span className="graph-view" role="tablist" aria-label={t('Farben zeigen')}>
          <button role="tab" aria-selected={!byMastery} className={!byMastery ? 'on' : ''} onClick={() => set('view', 'folders')}>
            {t('Ordner')}
          </button>
          <button role="tab" aria-selected={byMastery} className={byMastery ? 'on' : ''} onClick={() => set('view', 'mastery')} title={t('Zeigt, wie gut du die Karten jeder Notiz gerade kannst')}>
            {t('Wissensstand')}
          </button>
        </span>
        {focusTitle && (
          <span className="graph-focus">
            <Icon name="target" /> {focusTitle}
            <select value={settings.depth} onChange={(e) => set('depth', Number(e.target.value))} title={t('Tiefe')}>
              {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d === 1 ? t('1 Schritt') : t('{n} Schritte', { n: d })}</option>)}
            </select>
            <button className="icon-btn" title={t('Ganzen Graph zeigen')} onClick={() => onFocus(undefined)}><Icon name="x" /></button>
          </span>
        )}
        <span className="spacer" />
        <span className="graph-actions">
          <button className="icon-btn" title={t('Zeitraffer: Notizen in der Reihenfolge ihrer Entstehung')} onClick={animate} disabled={reveal !== null}>
            <Icon name="play" />
          </button>
          <button className="icon-btn" title={t('Alles zeigen')} onClick={() => fg.current?.zoomToFit(500, 90)}>
            <Icon name="fit" />
          </button>
          <button className={`icon-btn ${panel ? 'on' : ''}`} title={t('Graph-Einstellungen')} onClick={() => setPanel((p) => !p)}>
            <Icon name="sliders" />
          </button>
        </span>
      </div>

      {panel && <GraphPanel settings={settings} series={pal.series} set={set} replace={setSettings} onClose={() => setPanel(false)} />}

      {byMastery ? (
        <div className="graph-legend">
          {STATUS_ORDER.filter((s) => statusCounts.get(s)).map((s) => (
            <span key={s} className="graph-chip">
              <i className={`status-dot status-${s}`} /> {STATUS_LABEL[s]} <b>{statusCounts.get(s)}</b>
            </span>
          ))}
        </div>
      ) : (
        legend.length > 1 && (
          <div className="graph-legend">
            {legend.map(([name, color]) => {
              const off = settings.hiddenGroups.includes(name)
              return (
                <button
                  key={name}
                  className={`graph-chip ${off ? 'off' : ''}`}
                  title={off ? t('Einblenden') : t('Ausblenden')}
                  onClick={() => set('hiddenGroups', off ? settings.hiddenGroups.filter((x) => x !== name) : [...settings.hiddenGroups, name])}
                >
                  <i style={{ background: color }} /> {groupLabel(name)}
                </button>
              )
            })}
          </div>
        )
      )}

      <ForceGraph2D<GNode, GLink>
        ref={fg}
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor={pal.bg}
        autoPauseRedraw={false}
        nodeId="id"
        nodeLabel={() => ''}
        cooldownTicks={reveal !== null ? 30 : 160}
        d3VelocityDecay={0.34}
        onEngineStop={() => {
          if (fitted.current) return
          fitted.current = true
          fg.current?.zoomToFit(400, 110)
          setTimeout(() => {
            const z = fg.current?.zoom() ?? 1
            if (z > 2) fg.current?.zoom(2, 300)
          }, 450)
        }}
        onRenderFramePre={drawRegions}
        nodeCanvasObject={(n, ctx, scale) => {
          const e = emphasis(n.id)
          const isHover = n.id === hover
          const marked = isHover || n.id === focus || (matches?.has(n.id) && hover === null)
          const r = radius(n) * (isHover ? 1.15 : 1)
          const hollow = byMastery && (n.status === 'new' || n.status === 'none')
          ctx.globalAlpha = e
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2)
          if (hollow) {
            // not studied yet / no cards: an outline only, so filled dots are what you have actually learned
            ctx.fillStyle = pal.bg
            ctx.fill()
            ctx.lineWidth = (n.status === 'new' ? 1.6 : 1.1) / Math.max(scale, 0.7)
            ctx.strokeStyle = n.status === 'new' ? pal.accent : withAlpha(pal.muted, 0.8)
            ctx.stroke()
          } else {
            ctx.fillStyle = nodeColor(n)
            ctx.fill()
            // a hairline of paper around each dot keeps touching notes and crossing links apart
            ctx.lineWidth = 1.5 / scale
            ctx.strokeStyle = pal.bg
            ctx.stroke()
          }
          if (marked) {
            ctx.lineWidth = 1.5 / scale
            ctx.strokeStyle = pal.text
            ctx.beginPath()
            ctx.arc(n.x!, n.y!, r + 3 / scale, 0, Math.PI * 2)
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, radius(n) + 6, 0, Math.PI * 2)
          ctx.fill()
        }}
        onRenderFramePost={drawLabels}
        linkColor={(l) => {
          const a = Math.min(alpha.current.get(idOf(l.source)) ?? 1, alpha.current.get(idOf(l.target)) ?? 1)
          if (hover !== null && linkTouches(l, hover)) return withAlpha(pal.text, 0.7)
          return a < 0.5 ? pal.faint : l.kind === 'link' ? pal.link : pal.semantic
        }}
        linkWidth={(l) => settings.linkWidth * (hover !== null && linkTouches(l, hover) ? 1.4 : l.kind === 'link' ? 0.9 : 0.7)}
        linkLineDash={(l) => (l.kind === 'semantic' ? [1.5, 3] : null)}
        linkDirectionalArrowLength={(l) => (settings.arrows && l.kind === 'link' ? 3.5 * settings.linkWidth : 0)}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={() => pal.label}
        onNodeHover={(n) => {
          setHover(n ? n.id : null)
          setTip(n && fg.current ? fg.current.graph2ScreenCoords(n.x!, n.y!) : null)
        }}
        onNodeClick={(n, e) => (e.shiftKey || e.altKey ? onFocus(n.id) : onOpen(n.id))}
        onNodeRightClick={(n) => onFocus(n.id)}
        onNodeDragEnd={(n) => {
          // pin dragged notes where they were dropped, like Obsidian
          ;(n as GNode & { fx?: number; fy?: number }).fx = n.x
          ;(n as GNode & { fx?: number; fy?: number }).fy = n.y
        }}
        onZoom={() => setTip(null)}
        onBackgroundClick={() => setQuery('')}
      />

      {hovered && tip && (
        <div className="graph-tip" style={{ left: Math.min(Math.max(tip.x - 20, 12), size.w - 250), top: tip.y + 26 > size.h - 96 ? tip.y - 96 : tip.y + 26 }}>
          <b>{hovered.title}</b>
          <span className="graph-tip-path">{hovered.path.split('/').slice(0, -1).join(' › ') || t('Notizen')}</span>
          {hoveredMastery ? (
            <span className="graph-tip-row">
              <i className={`status-dot status-${hovered.status}`} />
              {STATUS_LABEL[hovered.status]}
              {hovered.status !== 'new' && ` · ${t('{n} % abrufbar', { n: Math.round(hoveredMastery.retention * 100) })}`}
              {' · '}
              {hoveredMastery.cards === 1 ? t('1 Karte') : t('{n} Karten', { n: hoveredMastery.cards })}
              {hoveredMastery.due > 0 && ` · ${t('{n} fällig', { n: hoveredMastery.due })}`}
            </span>
          ) : (
            <span className="graph-tip-row muted">{t('Keine Karten')}</span>
          )}
        </div>
      )}

      {reveal !== null && <div className="graph-timelapse">{t('{n} / {total} Notizen', { n: reveal, total: order.length })}</div>}
      {byMastery && (statusCounts.get('weak') || statusCounts.get('fading')) ? (
        <button
          className="graph-study"
          onClick={() => {
            // the weakest note first: lowest recall among the notes that are slipping
            const worst = data.nodes
              .filter((n) => n.status === 'weak' || n.status === 'fading')
              .sort((a, b) => (mastery.get(a.id)?.retention ?? 1) - (mastery.get(b.id)?.retention ?? 1))[0]
            if (worst) onStudy(worst.path, worst.title)
          }}
        >
          <Icon name="cards" /> {t('Schwächste Notiz lernen')}
        </button>
      ) : (
        <div className="graph-hint">{t('Klick öffnet · Rechtsklick zeigt die Umgebung · Ziehen pinnt')}</div>
      )}
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

/** Graph settings, modelled on Obsidian's graph view (filters, groups, display, forces). */

export interface Group {
  id: string
  /** "path:Uni/Bio", "title:Mitose" or plain text matched against title and path */
  query: string
  color: number // palette slot 0..7
}

export interface Settings {
  /** What the colours mean: the folder a note is in, or how well its flashcards are known. */
  view: 'folders' | 'mastery'
  /** Tinted areas with a caption behind the notes of each group, like regions on a map. */
  regions: boolean
  // filters
  links: boolean
  subpages: boolean
  semantic: boolean
  minSimilarity: number
  orphans: boolean
  hiddenGroups: string[]
  // groups
  autoGroups: boolean
  colorDepth: 0 | 1 | 2 // 0 = automatic
  groups: Group[]
  // display
  arrows: boolean
  labels: 'auto' | 'always' | 'hover'
  textFade: number // 0..1, zoom level at which labels appear
  nodeSize: number
  linkWidth: number
  // forces
  center: number
  repel: number
  linkForce: number
  distance: number
  // local graph
  depth: number
}

export const DEFAULTS: Settings = {
  view: 'folders',
  regions: true,
  links: true,
  subpages: true,
  semantic: true,
  minSimilarity: 0,
  orphans: true,
  hiddenGroups: [],
  autoGroups: true,
  colorDepth: 0,
  groups: [],
  arrows: false,
  labels: 'auto',
  textFade: 0.3,
  nodeSize: 1,
  linkWidth: 1,
  center: 0.06,
  repel: 220,
  linkForce: 0.5,
  distance: 58,
  depth: 2,
}

export type Status = 'strong' | 'fading' | 'weak' | 'new' | 'none'

/** Canvas colours, read from the app's CSS theme so the graph follows light and dark mode. */
export interface Palette {
  bg: string
  text: string
  label: string
  muted: string
  link: string
  faint: string
  semantic: string
  accent: string
  series: string[]
  status: Record<'strong' | 'fading' | 'weak', string>
}

export function palette(css: CSSStyleDeclaration): Palette {
  const v = (n: string) => css.getPropertyValue(n).trim()
  return {
    bg: v('--bg'),
    text: v('--text'),
    label: v('--text-2'),
    muted: v('--muted'),
    link: v('--graph-link'),
    faint: v('--graph-faint'),
    semantic: v('--graph-semantic'),
    accent: v('--accent'),
    series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
    status: { strong: v('--status-good'), fading: v('--status-warning'), weak: v('--status-critical') },
  }
}

/** [r, g, b] of "#rgb", "#rrggbb" or "rgb(a)(…)". */
function rgb(color: string): [number, number, number] {
  if (color.startsWith('#')) {
    const h = color.length === 4 ? [...color.slice(1)].map((c) => c + c).join('') : color.slice(1, 7)
    const n = parseInt(h, 16)
    return [n >> 16, (n >> 8) & 255, n & 255]
  }
  const m = color.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128]
  return [m[0], m[1], m[2]]
}

/** Opaque mix of two colours: `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number) {
  const x = rgb(a), y = rgb(b)
  return `rgb(${x.map((c, i) => Math.round(c + (y[i] - c) * t)).join(', ')})`
}

export function withAlpha(color: string, a: number) {
  const [r, g, b] = rgb(color)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

const STORE = 'synapse.graph.v4'

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s))
  } catch {
    /* private mode */
  }
}

export function matchesGroup(g: Group, title: string, path: string) {
  const q = g.query.trim().toLowerCase()
  if (!q) return false
  if (q.startsWith('path:')) return path.toLowerCase().startsWith(q.slice(5).trim())
  if (q.startsWith('title:')) return title.toLowerCase().includes(q.slice(6).trim())
  return title.toLowerCase().includes(q) || path.toLowerCase().includes(q)
}

/** Convex hull (Andrew's monotone chain) of 2D points, counter-clockwise. */
export function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (pts: [number, number][]) => {
    const out: [number, number][] = []
    for (const q of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop()
      out.push(q)
    }
    out.pop()
    return out
  }
  return [...half(p), ...half([...p].reverse())]
}

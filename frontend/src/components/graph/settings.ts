/** Graph settings, modelled on Obsidian's graph view (filters, groups, display, forces) plus visual presets. */

export type StyleName = 'clean' | 'night' | 'neon' | 'stars'

export interface Group {
  id: string
  /** "path:Uni/Bio", "title:Mitose" or plain text matched against title and path */
  query: string
  color: number // palette slot 0..7
}

export interface Settings {
  style: StyleName
  glow: number // 0..1
  background: 'none' | 'dots' | 'stars'
  particles: boolean
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
  style: 'clean',
  glow: 0,
  background: 'dots',
  particles: false,
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
  textFade: 0.35,
  nodeSize: 1,
  linkWidth: 1,
  center: 0.08,
  repel: 190,
  linkForce: 0.55,
  distance: 52,
  depth: 2,
}

export interface Preset {
  name: string
  hint: string
  apply: Partial<Settings>
}

export const PRESETS: Record<StyleName, Preset> = {
  clean: { name: 'Klar', hint: 'ruhig, folgt dem App-Thema', apply: { style: 'clean', glow: 0, background: 'dots', particles: false } },
  night: { name: 'Nacht', hint: 'dunkel mit Punktraster', apply: { style: 'night', glow: 0.25, background: 'dots', particles: false } },
  neon: { name: 'Neon', hint: 'leuchtende Knoten, Signalfluss', apply: { style: 'neon', glow: 0.8, background: 'none', particles: true } },
  stars: { name: 'Sternbild', hint: 'Sternenhimmel, sanftes Leuchten', apply: { style: 'stars', glow: 0.55, background: 'stars', particles: false } },
}

/** Canvas colours. "clean" reads the CSS theme; the dark presets use the dark palette steps. */
export interface Palette {
  bg: string
  bg2?: string // second gradient stop
  text: string
  label: string
  labelBg: string
  labelHalo: string // text halo + node ring, normally the background colour
  grid: string
  link: string
  faint: string
  neutral: string
  accent: string
  semantic: string
  series: string[]
  tintLinks: boolean
}

const DARK_SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const NEON_SERIES = ['#5aa2ff', '#ff7a45', '#2fe0a0', '#ffc233', '#ff6fae', '#45d64a', '#a99cff', '#ff7676']

export function palette(style: StyleName, css: () => CSSStyleDeclaration): Palette {
  if (style === 'clean') {
    const c = css()
    const v = (n: string) => c.getPropertyValue(n).trim()
    return {
      bg: v('--bg'),
      text: v('--text'),
      label: v('--text-2'),
      labelBg: v('--graph-label-bg'),
      labelHalo: v('--bg'),
      grid: v('--graph-grid'),
      link: v('--graph-link'),
      faint: v('--graph-faint'),
      neutral: v('--muted'),
      accent: v('--accent'),
      semantic: v('--graph-semantic'),
      series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
      tintLinks: false,
    }
  }
  const dark = {
    text: '#eef0f4',
    label: '#a9afbb',
    labelBg: 'rgba(12, 14, 19, 0.72)',
    grid: 'rgba(255, 255, 255, 0.09)',
    link: 'rgba(255, 255, 255, 0.13)',
    faint: 'rgba(255, 255, 255, 0.035)',
    neutral: '#8a909c',
    accent: '#9ab8ff',
    semantic: 'rgba(170, 180, 200, 0.32)',
  }
  if (style === 'night') return { ...dark, bg: '#111318', labelHalo: '#111318', series: DARK_SERIES, tintLinks: false }
  if (style === 'neon') return { ...dark, bg: '#07080c', labelHalo: '#07080c', series: NEON_SERIES, neutral: '#b9c1d0', tintLinks: true }
  return { ...dark, bg: '#0b1124', bg2: '#04050b', labelHalo: '#070a17', series: NEON_SERIES, neutral: '#dfe6ff', link: 'rgba(200, 215, 255, 0.16)', tintLinks: false }
}

const STORE = 'synapse.graph.v3'

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

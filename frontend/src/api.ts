export interface NoteSummary {
  id: number
  title: string
  updated_at: number
  /** Vault-relative Markdown file, e.g. "Uni/Bio/Zelle.md". */
  path: string
  created_at?: number
}

/** Display name of a note; new notes start without a title. */
export const titleOf = (title: string) => title.trim() || 'Ohne Titel'

export interface FolderMeta {
  color: string
  icon: string
}

export interface Tree {
  folders: string[]
  /** Colour / emoji per folder path, only for customised folders. */
  folder_meta?: Record<string, FolderMeta>
  notes: NoteSummary[]
}

export interface Note extends NoteSummary {
  content: string
  created_at: number
}

export interface SearchHit {
  id: number
  title: string
  snippet: string
}

export interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'semantic'
  weight: number
}

export interface GraphData {
  nodes: NoteSummary[]
  edges: GraphEdge[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.status === 204 ? (undefined as T) : res.json()
}

export const api = {
  listNotes: () => request<NoteSummary[]>('/notes'),
  getNote: (id: number) => request<Note>(`/notes/${id}`),
  createNote: (title: string, content = '', where: { folder?: string; parentId?: number } = {}) =>
    request<Note>('/notes', {
      method: 'POST',
      body: JSON.stringify({ title, content, folder: where.folder, parent_id: where.parentId }),
    }),
  getMarkdown: (id: number) => request<Note & { markdown: string }>(`/notes/${id}?format=markdown`),
  updateMarkdown: (id: number, title: string, markdown: string) =>
    request<Note>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify({ title, markdown }) }),
  moveNote: (id: number, folder: string) =>
    request<NoteSummary>(`/notes/${id}/move`, { method: 'PUT', body: JSON.stringify({ folder }) }),
  tree: () => request<Tree>('/tree'),
  createFolder: (path: string) => request<{ path: string }>('/folders', { method: 'POST', body: JSON.stringify({ path }) }),
  renameFolder: (from: string, to: string) =>
    request<{ path: string }>('/folders', { method: 'PUT', body: JSON.stringify({ from, to }) }),
  setFolderMeta: (path: string, meta: FolderMeta) =>
    request<void>('/folders/meta', { method: 'PUT', body: JSON.stringify({ path, ...meta }) }),
  deleteFolder: (path: string) => request<void>(`/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  updateNote: (id: number, title: string, content: string) =>
    request<Note>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify({ title, content }) }),
  deleteNote: (id: number) => request<void>(`/notes/${id}`, { method: 'DELETE' }),
  backlinks: (id: number) => request<NoteSummary[]>(`/notes/${id}/backlinks`),
  search: (q: string) => request<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`),
  graph: () => request<GraphData>('/graph'),
}

/** Same rules as the backend parser: [[Target]], [[Target|Alias]], [[Target#Heading]]. */
export function extractWikilinks(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const target = m[1].split(/[|#]/)[0].trim()
    if (target) out.add(target)
  }
  return [...out]
}

export interface Neighbor {
  id: number
  title: string
  score: number
}

export type ClozeSegment = { text: string } | { cloze: string }

/** A covered region of an image, in fractions of the image size. */
export interface Mask {
  id: string
  x: number
  y: number
  w: number
  h: number
  label?: string
}

export interface Card {
  id: number
  note_id: number
  note_title: string
  kind: 'basic' | 'reverse' | 'list' | 'cloze' | 'occlusion'
  front: string
  data: { back?: string; items?: string[]; segments?: ClozeSegment[]; src?: string; masks?: Mask[] }
  state: 0 | 1 | 2 | 3
  due: number
  reps: number
  lapses: number
  stability: number
  intervals?: Record<'1' | '2' | '3' | '4', number>
  exam_date: number | null
}

export interface ReviewStats {
  due: number
  new: number
  total: number
  reviewed_today: number
}

export interface Status {
  semantic: { enabled: boolean; model: string; indexed: number; pending: number }
  vault: string
}

export interface Exam {
  id: number
  name: string
  date: number
  notes: { id: number; title: string }[]
  progress: {
    cards: number
    new: number
    due: number
    mastered: number
    new_today: number
    predicted_retention: number
  }
}

export interface ExamInput {
  name: string
  date: string
  note_ids: number[]
}

export const examApi = {
  list: () => request<Exam[]>('/exams'),
  create: (e: ExamInput) => request<Exam>('/exams', { method: 'POST', body: JSON.stringify(e) }),
  update: (id: number, e: ExamInput) => request<Exam>(`/exams/${id}`, { method: 'PUT', body: JSON.stringify(e) }),
  remove: (id: number) => request<void>(`/exams/${id}`, { method: 'DELETE' }),
}

function scopeQuery(exam: number, path: string) {
  const q = new URLSearchParams()
  if (exam) q.set('exam', String(exam))
  if (path) q.set('path', path)
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const cardApi = {
  noteCards: (id: number) => request<Card[]>(`/notes/${id}/cards`),
  queue: (exam = 0, path = '') => request<Card[]>(`/review/queue${scopeQuery(exam, path)}`),
  stats: (exam = 0, path = '') => request<ReviewStats>(`/review/stats${scopeQuery(exam, path)}`),
  review: (id: number, rating: 1 | 2 | 3 | 4) =>
    request<Card>(`/cards/${id}/review`, { method: 'POST', body: JSON.stringify({ rating }) }),
}

export const semanticApi = {
  similar: (id: number) => request<Neighbor[]>(`/notes/${id}/similar`),
  search: (q: string) => request<Neighbor[]>(`/semantic-search?q=${encodeURIComponent(q)}`),
  status: () => request<Status>('/status'),
}

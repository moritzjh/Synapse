export interface NoteSummary {
  id: number
  title: string
  updated_at: number
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
  createNote: (title: string, content = '') =>
    request<Note>('/notes', { method: 'POST', body: JSON.stringify({ title, content }) }),
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

export interface Card {
  id: number
  note_id: number
  note_title: string
  kind: 'basic' | 'reverse' | 'list' | 'cloze'
  front: string
  data: { back?: string; items?: string[]; segments?: ClozeSegment[] }
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

export const cardApi = {
  noteCards: (id: number) => request<Card[]>(`/notes/${id}/cards`),
  queue: (exam = 0) => request<Card[]>(`/review/queue${exam ? `?exam=${exam}` : ''}`),
  stats: (exam = 0) => request<ReviewStats>(`/review/stats${exam ? `?exam=${exam}` : ''}`),
  review: (id: number, rating: 1 | 2 | 3 | 4) =>
    request<Card>(`/cards/${id}/review`, { method: 'POST', body: JSON.stringify({ rating }) }),
}

export const semanticApi = {
  similar: (id: number) => request<Neighbor[]>(`/notes/${id}/similar`),
  search: (q: string) => request<Neighbor[]>(`/semantic-search?q=${encodeURIComponent(q)}`),
  status: () => request<Status>('/status'),
}

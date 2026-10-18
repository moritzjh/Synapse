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

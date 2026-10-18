import { useEffect, useState } from 'react'
import { api, type NoteSummary, type SearchHit } from '../api'

interface Props {
  notes: NoteSummary[]
  selectedId: number | null
  onSelect: (id: number) => void
  onCreate: () => void
}

export default function Sidebar({ notes, selectedId, onSelect, onCreate }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])

  useEffect(() => {
    if (!query.trim()) return setHits([])
    const t = setTimeout(() => api.search(query).then(setHits).catch(() => setHits([])), 150)
    return () => clearTimeout(t)
  }, [query])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Synapse</h1>
        <button onClick={onCreate} title="Neue Notiz">+</button>
      </div>
      <input
        className="search"
        placeholder="Suchen…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="note-list">
        {query.trim()
          ? hits.map((h) => (
              <li key={h.id} className={h.id === selectedId ? 'selected' : ''} onClick={() => onSelect(h.id)}>
                <div className="title">{h.title}</div>
                {/* snippet comes from our own backend; only <b> highlight tags are inserted */}
                <div className="snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(h.snippet) }} />
              </li>
            ))
          : notes.map((n) => (
              <li key={n.id} className={n.id === selectedId ? 'selected' : ''} onClick={() => onSelect(n.id)}>
                <div className="title">{n.title}</div>
              </li>
            ))}
      </ul>
    </aside>
  )
}

// Escape everything, then re-enable the <b> markers FTS5 inserted.
function escapeSnippet(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)b&gt;/g, '<$1b>')
}

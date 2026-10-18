import { useEffect, useState } from 'react'
import { api, semanticApi, type NoteSummary, type SearchHit, type Status } from '../api'
import type { View } from '../App'
import { Icon } from './Icons'

interface Props {
  notes: NoteSummary[]
  view: View
  due: number
  status: Status | null
  onNavigate: (v: View) => void
  onCreate: () => void
}

interface Hit extends SearchHit {
  semantic?: boolean
}

export default function Sidebar({ notes, view, due, status, onNavigate, onCreate }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])

  useEffect(() => {
    if (!query.trim()) return setHits([])
    const t = setTimeout(async () => {
      // Exact matches first, then notes that are only similar in meaning.
      const [text, sem] = await Promise.all([api.search(query), semanticApi.search(query).catch(() => [])])
      const seen = new Set(text.map((h) => h.id))
      setHits([
        ...text,
        ...sem.filter((s) => !seen.has(s.id) && s.score > 0.3).map((s) => ({ id: s.id, title: s.title, snippet: '', semantic: true })),
      ])
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  const selected = view.kind === 'note' ? view.id : null
  const nav = (kind: 'graph' | 'review' | 'exams', icon: 'graph' | 'cards' | 'calendar', label: string, badge?: number) => (
    <button className={`nav-item ${view.kind === kind ? 'active' : ''}`} onClick={() => onNavigate({ kind } as View)}>
      <Icon name={icon} />
      {label}
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" /> Synapse
      </div>
      <label className="side-search">
        <Icon name="search" />
        <input placeholder="Suchen" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <nav className="nav">
        {nav('review', 'cards', 'Lernen', due)}
        {nav('exams', 'calendar', 'Prüfungen')}
        {nav('graph', 'graph', 'Graph')}
      </nav>

      <div className="side-section">
        <span>{query.trim() ? 'Treffer' : 'Notizen'}</span>
        <button className="icon-btn" title="Neue Notiz" onClick={onCreate}>
          <Icon name="plus" />
        </button>
      </div>
      <ul className="note-list">
        {(query.trim() ? hits : notes).map((n) => (
          <li key={n.id} className={n.id === selected ? 'selected' : ''}>
            <button onClick={() => onNavigate({ kind: 'note', id: n.id })} title={n.title}>
              {n.title}
              {'snippet' in n && n.snippet && (
                // snippet comes from our own backend; only the <b> highlight markers are kept
                <span className="snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(n.snippet) }} />
              )}
              {'semantic' in n && n.semantic && <span className="snippet">ähnlicher Inhalt</span>}
            </button>
          </li>
        ))}
        {query.trim() && hits.length === 0 && <li className="muted" style={{ padding: '4px 10px' }}>Nichts gefunden</li>}
      </ul>
      <div className="side-footer" title={status?.vault}>
        {status?.semantic.enabled ? `${status.semantic.model} · ${status.semantic.indexed} indexiert` : 'Kein Embedding-Modell'}
        <br />
        {status && `Vault: ${status.vault.split('/').slice(-2).join('/')}`}
      </div>
    </aside>
  )
}

function escapeSnippet(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)b&gt;/g, '<$1b>')
}

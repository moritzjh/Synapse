import { useCallback, useEffect, useState } from 'react'
import { api, type NoteSummary } from './api'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import GraphView from './components/GraphView'
import Review from './components/Review'
import { cardApi, semanticApi, type Status } from './api'

type View = 'editor' | 'graph' | 'review'

export default function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<View>('editor')
  const [error, setError] = useState<string | null>(null)
  const [due, setDue] = useState(0)
  const [status, setStatus] = useState<Status | null>(null)

  const refreshCounts = useCallback(() => {
    cardApi.stats().then((s) => setDue(s.due + s.new)).catch(() => {})
    semanticApi.status().then(setStatus).catch(() => {})
  }, [])

  const refresh = useCallback(async () => {
    try {
      setNotes(await api.listNotes())
      refreshCounts()
      setError(null)
    } catch (e) {
      setError(`Backend nicht erreichbar: ${(e as Error).message}`)
    }
  }, [refreshCounts])

  useEffect(() => {
    refresh()
  }, [refresh])

  const openNote = (id: number) => {
    setSelectedId(id)
    setView('editor')
  }

  const createNote = async (title = 'Untitled') => {
    const note = await api.createNote(title)
    await refresh()
    openNote(note.id)
  }

  // Follows a [[wikilink]]: opens the note with that title, or creates it.
  const openByTitle = async (title: string) => {
    const existing = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (existing) openNote(existing.id)
    else await createNote(title)
  }

  const deleteNote = async (id: number) => {
    await api.deleteNote(id)
    if (selectedId === id) setSelectedId(null)
    await refresh()
  }

  return (
    <div className="app">
      <Sidebar
        notes={notes}
        selectedId={selectedId}
        onSelect={openNote}
        onCreate={() => createNote()}
      />
      <main className="main">
        <header className="toolbar">
          <button className={view === 'editor' ? 'active' : ''} onClick={() => setView('editor')}>
            Notiz
          </button>
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
            Graph
          </button>
          <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>
            Lernen {due > 0 && <span className="count">{due}</span>}
          </button>
          <span className="spacer" />
          {status && (
            <span className="model-status" title="Lokales Embedding-Modell für automatische Verknüpfungen">
              {status.semantic.enabled
                ? `🧠 ${status.semantic.model} · ${status.semantic.indexed} indexiert${status.semantic.pending ? ` · ${status.semantic.pending} in Arbeit` : ''}`
                : '🧠 Modell aus'}
            </span>
          )}
          {error && <span className="error">{error}</span>}
        </header>
        {view === 'graph' ? (
          <GraphView onOpen={openNote} />
        ) : view === 'review' ? (
          <Review onOpenNote={openNote} onChanged={refreshCounts} />
        ) : selectedId !== null ? (
          <Editor
            key={selectedId}
            noteId={selectedId}
            titles={notes.map((n) => n.title)}
            onSaved={refresh}
            onOpenLink={openByTitle}
            onOpenNote={openNote}
            onDelete={deleteNote}
          />
        ) : (
          <div className="empty">
            <p>Keine Notiz ausgewählt.</p>
            <button onClick={() => createNote()}>Neue Notiz</button>
          </div>
        )}
      </main>
    </div>
  )
}

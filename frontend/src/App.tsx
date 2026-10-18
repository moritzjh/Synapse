import { useCallback, useEffect, useState } from 'react'
import { api, type NoteSummary } from './api'
import Sidebar from './components/Sidebar'
import Editor from './components/Editor'
import GraphView from './components/GraphView'

type View = 'editor' | 'graph'

export default function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<View>('editor')
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setNotes(await api.listNotes())
      setError(null)
    } catch (e) {
      setError(`Backend nicht erreichbar: ${(e as Error).message}`)
    }
  }, [])

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
          {error && <span className="error">{error}</span>}
        </header>
        {view === 'graph' ? (
          <GraphView onOpen={openNote} />
        ) : selectedId !== null ? (
          <Editor
            key={selectedId}
            noteId={selectedId}
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

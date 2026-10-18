import { useCallback, useEffect, useState } from 'react'
import { api, cardApi, examApi, semanticApi, type Exam, type NoteSummary, type Status } from './api'
import Sidebar from './components/Sidebar'
import NotePage from './components/Editor'
import GraphView from './components/GraphView'
import Review from './components/Review'
import Exams from './components/Exams'

export type View =
  | { kind: 'note'; id: number }
  | { kind: 'graph' }
  | { kind: 'review'; exam?: number }
  | { kind: 'exams' }
  | { kind: 'home' }

export default function App() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
  const [due, setDue] = useState(0)
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshMeta = useCallback(() => {
    cardApi.stats().then((s) => setDue(s.due + s.new)).catch(() => {})
    semanticApi.status().then(setStatus).catch(() => {})
    examApi.list().then(setExams).catch(() => {})
  }, [])

  const refresh = useCallback(async () => {
    try {
      setNotes(await api.listNotes())
      setError(null)
      refreshMeta()
    } catch (e) {
      setError(`Backend nicht erreichbar (${(e as Error).message})`)
    }
  }, [refreshMeta])

  useEffect(() => {
    refresh()
    // Picks up notes edited in Obsidian or created through MCP.
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [refresh])

  const openNote = (id: number) => setView({ kind: 'note', id })

  const createNote = async (title = '') => {
    const note = await api.createNote(title || 'Ohne Titel')
    await refresh()
    openNote(note.id)
  }

  const openByTitle = async (title: string) => {
    const existing = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (existing) openNote(existing.id)
    else await createNote(title)
  }

  const deleteNote = async (id: number) => {
    await api.deleteNote(id)
    setView({ kind: 'home' })
    await refresh()
  }

  return (
    <div className="app">
      <Sidebar notes={notes} view={view} due={due} status={status} onNavigate={setView} onCreate={() => createNote()} />
      <main className="main">
        {error && <div className="error-bar">{error}</div>}
        {view.kind === 'note' ? (
          <NotePage
            key={view.id}
            noteId={view.id}
            titles={notes.map((n) => n.title)}
            exams={exams.filter((e) => e.notes.some((n) => n.id === view.id))}
            onSaved={refresh}
            onOpenLink={openByTitle}
            onOpenNote={openNote}
            onDelete={deleteNote}
          />
        ) : view.kind === 'graph' ? (
          <GraphView onOpen={openNote} />
        ) : view.kind === 'review' ? (
          <Review key={view.exam ?? 0} exam={view.exam} exams={exams} onExam={(exam) => setView({ kind: 'review', exam })} onOpenNote={openNote} onChanged={refreshMeta} />
        ) : view.kind === 'exams' ? (
          <Exams exams={exams} notes={notes} onChanged={refreshMeta} onStudy={(exam) => setView({ kind: 'review', exam })} />
        ) : (
          <div className="empty-state">
            <p>Wähle eine Notiz oder lege eine neue an.</p>
            <button className="btn" onClick={() => createNote()}>Neue Notiz</button>
          </div>
        )}
      </main>
    </div>
  )
}

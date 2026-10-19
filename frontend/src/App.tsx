import { useCallback, useEffect, useState } from 'react'
import { api, cardApi, examApi, semanticApi, type Exam, type Status, type Tree } from './api'
import Sidebar from './components/Sidebar'
import NotePage from './components/Editor'
import GraphView from './components/GraphView'
import Review from './components/Review'
import Exams from './components/Exams'
import FolderPage from './components/FolderPage'
import type { StudyScope } from './components/Review'

export type View =
  | { kind: 'note'; id: number }
  | { kind: 'graph'; focus?: number }
  | { kind: 'review'; exam?: number; scope?: StudyScope }
  | { kind: 'folder'; path: string }
  | { kind: 'exams' }
  | { kind: 'home' }

export default function App() {
  const [tree, setTree] = useState<Tree>({ folders: [], notes: [] })
  const notes = tree.notes
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
      setTree(await api.tree())
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
  const openFolder = (path: string) => setView({ kind: 'folder', path })
  const study = (path: string, name: string) => setView({ kind: 'review', scope: { path, name } })

  const createNote = async (title = '', where: { folder?: string; parentId?: number } = {}) => {
    const note = await api.createNote(title, '', where)
    await refresh()
    openNote(note.id)
    return note
  }

  const openByTitle = async (title: string) => {
    const existing = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
    if (existing) openNote(existing.id)
    else await createNote(title)
  }

  const deleteNote = async (id: number) => {
    const folder = notes.find((n) => n.id === id)?.path.split('/').slice(0, -1).join('/')
    await api.deleteNote(id)
    if (view.kind === 'note' && view.id === id) setView(folder ? { kind: 'folder', path: folder } : { kind: 'home' })
    await refresh()
  }

  return (
    <div className="app">
      <Sidebar
        tree={tree}
        view={view}
        due={due}
        status={status}
        onNavigate={setView}
        onCreateNote={(where) => createNote('', where)}
        onDeleteNote={deleteNote}
        onStudy={study}
        onChanged={refresh}
      />
      <main className="main">
        {error && <div className="error-bar">{error}</div>}
        {view.kind === 'note' ? (
          <NotePage
            key={view.id}
            noteId={view.id}
            notes={notes}
            tree={tree}
            exams={exams.filter((e) => e.notes.some((n) => n.id === view.id))}
            onOpenFolder={openFolder}
            onStudy={study}
            onSaved={refresh}
            onOpenLink={openByTitle}
            onOpenNote={openNote}
            onDelete={deleteNote}
            onCreateSubpage={(title) => api.createNote(title, '', { parentId: view.id }).then(async (n) => (await refresh(), n))}
            onLocalGraph={() => setView({ kind: 'graph', focus: view.id })}
          />
        ) : view.kind === 'graph' ? (
          <GraphView key={view.focus ?? 0} focus={view.focus} onOpen={openNote} onFocus={(focus) => setView({ kind: 'graph', focus })} />
        ) : view.kind === 'review' ? (
          <Review key={`${view.exam ?? 0}:${view.scope?.path ?? ''}`} exam={view.exam} scope={view.scope} exams={exams} onExam={(exam) => setView({ kind: 'review', exam })} onOpenNote={openNote} onChanged={refreshMeta} />
        ) : view.kind === 'folder' ? (
          <FolderPage
            path={view.path}
            tree={tree}
            onFolder={openFolder}
            onNote={openNote}
            onCreateNote={(where) => createNote('', where)}
            onStudy={study}
            onChanged={refresh}
          />
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

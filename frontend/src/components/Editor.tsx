import { useEffect, useRef, useState } from 'react'
import { api, extractWikilinks, type NoteSummary } from '../api'

interface Props {
  noteId: number
  onSaved: () => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onDelete: (id: number) => void
}

const SAVE_DELAY_MS = 500

export default function Editor({ noteId, onSaved, onOpenLink, onOpenNote, onDelete }: Props) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([])
  const dirty = useRef(false)

  useEffect(() => {
    api.getNote(noteId).then((n) => {
      setTitle(n.title)
      setContent(n.content)
      setLoaded(true)
    })
    api.backlinks(noteId).then(setBacklinks)
  }, [noteId])

  // Debounced autosave.
  useEffect(() => {
    if (!loaded || !dirty.current) return
    setStatus('dirty')
    const t = setTimeout(async () => {
      setStatus('saving')
      await api.updateNote(noteId, title, content)
      dirty.current = false
      setStatus('saved')
      onSaved()
    }, SAVE_DELAY_MS)
    return () => clearTimeout(t)
  }, [title, content, loaded, noteId, onSaved])

  if (!loaded) return <div className="empty">Lädt…</div>

  const links = extractWikilinks(content)

  return (
    <div className="editor">
      <div className="editor-head">
        <input
          className="title-input"
          value={title}
          onChange={(e) => {
            dirty.current = true
            setTitle(e.target.value)
          }}
        />
        <span className={`status ${status}`}>
          {status === 'saved' ? 'Gespeichert' : status === 'saving' ? 'Speichert…' : 'Ungespeichert'}
        </span>
        <button className="danger" onClick={() => confirm('Notiz löschen?') && onDelete(noteId)}>
          Löschen
        </button>
      </div>
      <textarea
        className="content-input"
        value={content}
        placeholder="Schreib los… Verlinke andere Notizen mit [[Titel]]"
        onChange={(e) => {
          dirty.current = true
          setContent(e.target.value)
        }}
      />
      <div className="link-panels">
        <section>
          <h3>Links</h3>
          {links.length === 0 && <p className="muted">Keine</p>}
          {links.map((l) => (
            <button key={l} className="chip" onClick={() => onOpenLink(l)}>
              {l}
            </button>
          ))}
        </section>
        <section>
          <h3>Backlinks</h3>
          {backlinks.length === 0 && <p className="muted">Keine</p>}
          {backlinks.map((b) => (
            <button key={b.id} className="chip" onClick={() => onOpenNote(b.id)}>
              {b.title}
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}

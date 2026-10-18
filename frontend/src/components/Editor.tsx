import { useCallback, useEffect, useRef, useState } from 'react'
import { api, cardApi, extractWikilinks, semanticApi, type Card, type Exam, type Neighbor, type NoteSummary } from '../api'
import RichEditor, { toDoc, type Doc } from '../editor/RichEditor'
import { Icon } from './Icons'

interface Props {
  noteId: number
  titles: string[]
  exams: Exam[]
  onSaved: () => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onDelete: (id: number) => void
}

const SAVE_DELAY_MS = 500
const KIND_LABEL: Record<Card['kind'], string> = { basic: '→', reverse: '⇄', list: '☰', cloze: '▭' }

export default function NotePage({ noteId, titles, exams, onSaved, onOpenLink, onOpenNote, onDelete }: Props) {
  const [title, setTitle] = useState('')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [version, setVersion] = useState(0) // bump to reload the editor with new content
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([])
  const [similar, setSimilar] = useState<Neighbor[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const pending = useRef<{ title: string; doc: Doc } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const savedAt = useRef(0)
  const titlesRef = useRef(titles)
  titlesRef.current = titles

  const load = useCallback(async () => {
    const n = await api.getNote(noteId)
    const d = toDoc(n.content)
    savedAt.current = n.updated_at
    setTitle(n.title)
    setDoc(d)
    setText(docText(d))
    setVersion((v) => v + 1)
    api.backlinks(noteId).then(setBacklinks)
    cardApi.noteCards(noteId).then(setCards)
    semanticApi.similar(noteId).then(setSimilar).catch(() => setSimilar([]))
  }, [noteId])

  useEffect(() => {
    load()
  }, [load])

  // Reload when the note changed elsewhere (Obsidian, MCP) and we have no local edits.
  useEffect(() => {
    const t = setInterval(async () => {
      if (pending.current) return
      const n = await api.getNote(noteId).catch(() => null)
      if (n && n.updated_at !== savedAt.current && !pending.current) load()
    }, 3000)
    return () => clearInterval(t)
  }, [noteId, load])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const p = pending.current
    if (!p) return
    pending.current = null
    setStatus('saving')
    const saved = await api.updateNote(noteId, p.title, JSON.stringify(p.doc))
    savedAt.current = saved.updated_at
    setStatus(pending.current ? 'dirty' : 'saved')
    onSaved()
    cardApi.noteCards(noteId).then(setCards)
    setTimeout(() => semanticApi.similar(noteId).then(setSimilar).catch(() => {}), 2500)
  }, [noteId, onSaved])

  useEffect(() => () => void flush(), [flush])

  const schedule = (next: { title: string; doc: Doc }) => {
    pending.current = next
    setStatus('dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  if (!doc) return <div className="scroll" />

  const links = extractWikilinks(text)
  const currentDoc = () => pending.current?.doc ?? doc
  const days = (d: number) => Math.ceil((d - Date.now()) / 86_400_000)

  return (
    <div className="scroll">
      <div className="note-top">
        <span className="save-state">{status === 'saved' ? '' : status === 'saving' ? 'Speichert…' : 'Bearbeitet'}</span>
        <button className="icon-btn" title="Notiz löschen" onClick={() => confirm(`„${title}“ löschen?`) && onDelete(noteId)}>
          <Icon name="trash" />
        </button>
      </div>
      <div className="page note-page">
        <input
          className="title-input"
          value={title}
          placeholder="Ohne Titel"
          onChange={(e) => {
            setTitle(e.target.value)
            schedule({ title: e.target.value, doc: currentDoc() })
          }}
        />
        <div className="note-meta">
          {cards.length > 0 && (
            <span>
              <Icon name="cards" /> {cards.length} {cards.length === 1 ? 'Karte' : 'Karten'}
            </span>
          )}
          {exams.map((e) => (
            <span key={e.id} className="exam-tag">
              <Icon name="calendar" /> {e.name}
              {days(e.date) >= 0 ? ` · in ${days(e.date)} ${days(e.date) === 1 ? 'Tag' : 'Tagen'}` : ''}
            </span>
          ))}
        </div>

        <RichEditor
          key={version}
          initial={doc}
          getTitles={() => titlesRef.current}
          onOpenLink={async (t) => {
            await flush()
            onOpenLink(t)
          }}
          onChange={(d) => {
            setText(docText(d))
            schedule({ title, doc: d })
          }}
        />

        {(links.length > 0 || backlinks.length > 0 || similar.length > 0 || cards.length > 0) && (
          <div className="connections">
            {links.length > 0 && (
              <section>
                <h4>Verlinkt</h4>
                <div className="conn-list">
                  {links.map((l) => (
                    <button key={l} onClick={() => flush().then(() => onOpenLink(l))}>{l}</button>
                  ))}
                </div>
              </section>
            )}
            {backlinks.length > 0 && (
              <section>
                <h4>Erwähnt in</h4>
                <div className="conn-list">
                  {backlinks.map((b) => (
                    <button key={b.id} onClick={() => onOpenNote(b.id)}>{b.title}</button>
                  ))}
                </div>
              </section>
            )}
            {similar.length > 0 && (
              <section>
                <h4>Ähnlich</h4>
                <div className="conn-list">
                  {similar.slice(0, 6).map((s) => (
                    <button key={s.id} onClick={() => onOpenNote(s.id)}>
                      {s.title} <span className="score">{Math.round(s.score * 100)}%</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {cards.length > 0 && (
              <section>
                <h4>Karteikarten</h4>
                <div className="card-rows">
                  {cards.map((c) => (
                    <div key={c.id}>
                      <span className="kind">{KIND_LABEL[c.kind]}</span>
                      {c.front}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function docText(node: unknown): string {
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  const inner = (n.content ?? []).map(docText).join('')
  return n.type === 'paragraph' || n.type === 'heading' ? inner + '\n' : inner
}

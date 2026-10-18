import { useCallback, useEffect, useRef, useState } from 'react'
import { api, cardApi, extractWikilinks, semanticApi, type Card, type Neighbor, type NoteSummary } from '../api'
import RichEditor, { toDoc, type Doc } from '../editor/RichEditor'

interface Props {
  noteId: number
  titles: string[]
  onSaved: () => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onDelete: (id: number) => void
}

const SAVE_DELAY_MS = 500

export default function Editor({ noteId, titles, onSaved, onOpenLink, onOpenNote, onDelete }: Props) {
  const [title, setTitle] = useState('')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([])
  const [similar, setSimilar] = useState<Neighbor[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const pending = useRef<{ title: string; doc: Doc } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const titlesRef = useRef(titles)
  titlesRef.current = titles

  const refreshSide = useCallback(() => {
    api.backlinks(noteId).then(setBacklinks)
    cardApi.noteCards(noteId).then(setCards)
    semanticApi.similar(noteId).then(setSimilar).catch(() => setSimilar([]))
  }, [noteId])

  useEffect(() => {
    api.getNote(noteId).then((n) => {
      const d = toDoc(n.content)
      setTitle(n.title)
      setDoc(d)
      setText(docText(d))
    })
    refreshSide()
  }, [noteId, refreshSide])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const p = pending.current
    if (!p) return
    pending.current = null
    setStatus('saving')
    await api.updateNote(noteId, p.title, JSON.stringify(p.doc))
    setStatus(pending.current ? 'dirty' : 'saved')
    onSaved()
    cardApi.noteCards(noteId).then(setCards)
    // Embeddings are computed in the background (debounced), so refresh a bit later.
    setTimeout(() => semanticApi.similar(noteId).then(setSimilar).catch(() => {}), 2500)
  }, [noteId, onSaved])

  // Save pending edits when switching notes or closing the editor.
  useEffect(() => () => void flush(), [flush])

  const schedule = (next: { title: string; doc: Doc }) => {
    pending.current = next
    setStatus('dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  if (!doc) return <div className="empty">Lädt…</div>

  const links = extractWikilinks(text)
  const getDoc = () => pending.current?.doc ?? doc

  return (
    <div className="editor">
      <div className="editor-head">
        <input
          className="title-input"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            schedule({ title: e.target.value, doc: getDoc() })
          }}
        />
        <span className={`status ${status}`}>
          {status === 'saved' ? 'Gespeichert' : status === 'saving' ? 'Speichert…' : 'Ungespeichert'}
        </span>
        <button className="danger" onClick={() => confirm('Notiz löschen?') && onDelete(noteId)}>
          Löschen
        </button>
      </div>
      <div className="editor-body">
        <RichEditor
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
        <aside className="side-panel">
          <section>
            <h3>Links</h3>
            {links.length === 0 && <p className="muted">Keine</p>}
            {links.map((l) => (
              <button key={l} className="chip" onClick={() => flush().then(() => onOpenLink(l))}>
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
          <section>
            <h3>Ähnliche Notizen</h3>
            {similar.length === 0 && <p className="muted">Keine (Modell aktiv?)</p>}
            {similar.slice(0, 6).map((s) => (
              <button key={s.id} className="chip similar" onClick={() => onOpenNote(s.id)} title={`Ähnlichkeit ${s.score.toFixed(2)}`}>
                {s.title}
                <span className="score">{Math.round(s.score * 100)}%</span>
              </button>
            ))}
          </section>
          <section>
            <h3>Karteikarten ({cards.length})</h3>
            {cards.length === 0 && <p className="muted">Schreibe „Frage &gt;&gt; Antwort“ oder {'{{Lücke}}'}</p>}
            <ul className="card-list">
              {cards.map((c) => (
                <li key={c.id}>
                  <span className={`kind ${c.kind}`}>{KIND_LABEL[c.kind]}</span>
                  {c.front}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<Card['kind'], string> = { basic: '→', reverse: '←', list: '☰', cloze: '▭' }

function docText(node: unknown): string {
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  const inner = (n.content ?? []).map(docText).join('')
  return n.type === 'paragraph' || n.type === 'heading' ? inner + '\n' : inner
}

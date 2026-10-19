import { useCallback, useEffect, useRef, useState } from 'react'
import { api, cardApi, extractWikilinks, semanticApi, titleOf, type Card, type Exam, type Neighbor, type Note, type NoteSummary, type Tree } from '../api'
import RichEditor, { toDoc, type Doc } from '../editor/RichEditor'
import { Icon } from './Icons'
import Crumbs from './Crumbs'

interface Props {
  noteId: number
  notes: NoteSummary[]
  tree: Tree
  exams: Exam[]
  onOpenFolder: (path: string) => void
  onStudy: (path: string, name: string) => void
  onSaved: () => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onDelete: (id: number) => void
  onCreateSubpage: (title: string) => Promise<Note>
  onLocalGraph: () => void
}

const SAVE_DELAY_MS = 500
const KIND_LABEL: Record<Card['kind'], string> = { basic: '→', reverse: '⇄', list: '☰', cloze: '▭', occlusion: '▣' }

export default function NotePage(props: Props) {
  const { noteId, notes, exams, onSaved, onOpenLink, onOpenNote, onDelete } = props
  const [title, setTitle] = useState('')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [version, setVersion] = useState(0) // bump to reload the editor with new content
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const [backlinks, setBacklinks] = useState<NoteSummary[]>([])
  const [similar, setSimilar] = useState<Neighbor[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [source, setSource] = useState<string | null>(null) // raw Markdown mode
  const pending = useRef<{ title: string; doc?: Doc; markdown?: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const savedAt = useRef(0)
  const saving = useRef(false)
  const lastEdit = useRef(0)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const propsRef = useRef(props)
  propsRef.current = props
  const titleRef = useRef<HTMLInputElement>(null)
  const focusTitle = useRef<boolean | null>(false) // null once done, so reloads don't steal focus

  const load = useCallback(async () => {
    const n = await api.getNote(noteId)
    const d = toDoc(n.content)
    savedAt.current = n.updated_at
    if (focusTitle.current === false) focusTitle.current = n.title ? null : true // new note: start typing the title
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
      const busy = () => pending.current || saving.current || Date.now() - lastEdit.current < 4000
      if (busy() || source !== null) return
      const n = await api.getNote(noteId).catch(() => null)
      if (n && n.updated_at !== savedAt.current && !busy()) load()
    }, 3000)
    return () => clearInterval(t)
  }, [noteId, load, source])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const p = pending.current
    if (!p) return
    pending.current = null
    setStatus('saving')
    saving.current = true
    let saved
    try {
      saved =
        p.markdown !== undefined
          ? await api.updateMarkdown(noteId, p.title, p.markdown)
          : await api.updateNote(noteId, p.title, JSON.stringify(p.doc))
    } finally {
      saving.current = false
    }
    savedAt.current = saved.updated_at
    setStatus(pending.current ? 'dirty' : 'saved')
    onSaved()
    cardApi.noteCards(noteId).then(setCards)
    setTimeout(() => semanticApi.similar(noteId).then(setSimilar).catch(() => {}), 2500)
  }, [noteId, onSaved])

  useEffect(() => () => void flush(), [flush])

  const schedule = (next: { title: string; doc?: Doc; markdown?: string }) => {
    pending.current = next
    lastEdit.current = Date.now()
    setStatus('dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  const toggleSource = async () => {
    await flush()
    if (source === null) {
      setSource((await api.getMarkdown(noteId)).markdown)
    } else {
      setSource(null)
      await load()
    }
  }

  if (!doc) return <div className="scroll" />

  const links = extractWikilinks(text)
  const self = notes.find((n) => n.id === noteId)
  const folder = (self?.path ?? '').split('/').slice(0, -1).join('/')
  const days = (d: number) => Math.ceil((d - Date.now()) / 86_400_000)

  return (
    <div className="scroll">
      <div className="note-top">
        <Crumbs
          folder={folder}
          tree={props.tree}
          onFolder={(p) => flush().then(() => props.onOpenFolder(p))}
          onNote={(id) => flush().then(() => onOpenNote(id))}
        />
        <span className="save-state">{status === 'saved' ? '' : status === 'saving' ? 'Speichert…' : 'Bearbeitet'}</span>
        {cards.length > 0 && self?.path && (
          <button className="study-chip" title="Karten dieser Notiz lernen" onClick={() => flush().then(() => props.onStudy(self.path, titleOf(title)))}>
            <Icon name="cards" /> Lernen
          </button>
        )}
        <button className={`icon-btn ${source !== null ? 'on' : ''}`} title="Markdown-Quelltext" onClick={toggleSource}>
          <Icon name="code" />
        </button>
        <button className="icon-btn" title="Lokaler Graph" onClick={props.onLocalGraph}>
          <Icon name="graph" />
        </button>
        <button className="icon-btn" title="Notiz löschen" onClick={() => confirm(`„${titleOf(title)}“ löschen?`) && onDelete(noteId)}>
          <Icon name="trash" />
        </button>
      </div>
      <div className="page note-page">
        <input
          ref={(el) => {
            titleRef.current = el
            if (el && focusTitle.current) {
              focusTitle.current = null
              el.focus()
            }
          }}
          className="title-input"
          value={title}
          placeholder="Ohne Titel"
          onChange={(e) => {
            setTitle(e.target.value)
            schedule(source !== null ? { title: e.target.value, markdown: source } : { title: e.target.value, doc: pending.current?.doc ?? doc })
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
          {self?.path && source !== null && <span className="mono">{self.path}</span>}
        </div>

        {source !== null ? (
          <textarea
            className="source-editor"
            value={source}
            spellCheck={false}
            onChange={(e) => {
              setSource(e.target.value)
              schedule({ title, markdown: e.target.value })
            }}
          />
        ) : (
          <RichEditor
            key={version}
            initial={doc}
            getNotes={() => notesRef.current}
            onOpenLink={async (t) => {
              await flush()
              onOpenLink(t)
            }}
            onOpenNote={async (id) => {
              await flush()
              onOpenNote(id)
            }}
            onCreateSubpage={(t) => propsRef.current.onCreateSubpage(t)}
            onChange={(d) => {
              setText(docText(d))
              schedule({ title, doc: d })
            }}
          />
        )}

        {source === null && (links.length > 0 || backlinks.length > 0 || similar.length > 0 || cards.length > 0) && (
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
                    <button key={b.id} onClick={() => onOpenNote(b.id)}>{titleOf(b.title)}</button>
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
                      {titleOf(s.title)} <span className="score">{Math.round(s.score * 100)}%</span>
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
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { title?: string } }
  if (n.type === 'text') return n.text ?? ''
  if (n.type === 'pageLink') return `[[${n.attrs?.title ?? ''}]]\n`
  const inner = (n.content ?? []).map(docText).join('')
  return n.type === 'paragraph' || n.type === 'heading' ? inner + '\n' : inner
}

import { useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { Mermaid } from './Mermaid'
import { OcclusionImage } from './OcclusionImage'
import { Callout, PageLink } from './blocks'
import { Database } from './database/Database'
import type { NoteSummary } from '../api'
import { SyntaxHighlight } from './syntax'
import { SlashCommands, WikilinkSuggest } from './commands'
import { insertImages } from './upload'
import { CodeBlock } from './CodeBlock'
import { BlockBackspace, CardTyping, CaretMargin } from './typing'
import { BlockFormula, InlineFormula, editMath, katexOptions } from './Math'
import { BlockHandle, TARGETS, applyTarget, type Target } from './BlockHandle'
import type { Doc } from './doc'
import { t } from '../i18n'

export { toDoc } from './doc'
export type { Doc } from './doc'

interface Props {
  initial: Doc
  onChange: (doc: Doc) => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onCreateSubpage: (title: string) => Promise<{ id: number; title: string }>
  getNotes: () => NoteSummary[]
  getTitle?: () => string
}

export default function RichEditor(props: Props) {
  // Extensions are created once; route callbacks through a ref so they stay current.
  const cb = useRef(props)
  cb.current = props

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true } }),
      TableKit.configure({ table: { resizable: true } }),
      OcclusionImage.configure({ allowBase64: false }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlock,
      CardTyping,
      CaretMargin,
      BlockBackspace,
      BlockHandle,
      InlineFormula.configure({ katexOptions, onClick: (_n, pos) => editorRef.current?.isEditable && editMath(editorRef.current, pos, false) }),
      BlockFormula.configure({
        katexOptions: { ...katexOptions, displayMode: true },
        onClick: (_n, pos) => editorRef.current?.isEditable && editMath(editorRef.current, pos, true),
      }),
      Mermaid,
      Callout,
      Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }),
      DetailsSummary,
      DetailsContent,
      Database,
      PageLink.configure({ getNotes: () => cb.current.getNotes(), onOpenNote: (id) => cb.current.onOpenNote(id) }),
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node, editor, pos }) => {
          if (node.type.name === 'heading') return t('Überschrift {level}', { level: node.attrs.level })
          if (node.type.name === 'detailsSummary') return t('Titel')
          const parent = editor.state.doc.resolve(pos).parent.type.name
          if (parent === 'listItem' || parent === 'taskItem') return t('Liste')
          if (parent === 'blockquote') return t('Zitat')
          return t('Schreibe, oder tippe / für Blöcke')
        },
      }),
      SyntaxHighlight.configure({
        onOpenLink: (t) => cb.current.onOpenLink(t),
        getNotes: () => cb.current.getNotes(),
        getSelfTitle: () => cb.current.getTitle?.() ?? '',
      }),
      SlashCommands.configure({ createSubpage: (t) => cb.current.onCreateSubpage(t) }),
      WikilinkSuggest.configure({ getTitles: () => cb.current.getNotes().map((n) => n.title) }),
    ],
    content: props.initial,
    editorProps: {
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length || !editorRef.current) return false
        insertImages(editorRef.current, files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length || !editorRef.current) return false
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        insertImages(editorRef.current, files, pos)
        return true
      },
    },
    onUpdate: ({ editor }) => cb.current.onChange(editor.getJSON() as Doc),
  })
  const editorRef = useRef<Editor | null>(null)
  editorRef.current = editor

  if (!editor) return null
  return (
    <>
      <FormatMenu editor={editor} />
      <TableMenu editor={editor} />
      <EditorContent editor={editor} />
    </>
  )
}

/** Appears above selected text – the only formatting chrome in the UI. */
function FormatMenu({ editor }: { editor: Editor }) {
  const [typeOpen, setTypeOpen] = useState(false)
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      type: (e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : e.isActive('taskList')
              ? 'task'
              : e.isActive('orderedList')
                ? 'ordered'
                : e.isActive('bulletList')
                  ? 'bullet'
                  : e.isActive('blockquote')
                    ? 'quote'
                    : e.isActive('callout')
                      ? 'callout'
                      : 'text') as Target,
    }),
  })
  const c = () => editor.chain().focus()
  const cloze = () => {
    const { from, to } = editor.state.selection
    c().insertContentAt({ from, to }, `{{${editor.state.doc.textBetween(from, to)}}}`).run()
  }
  // "Frage Antwort" with "Antwort" selected → "Frage >> Antwort"
  const toCard = () => {
    const { from, to, $from } = editor.state.selection
    const start = $from.start()
    const before = editor.state.doc.textBetween(start, from)
    if (/ (>>|::) /.test(editor.state.doc.textBetween(start, $from.end()))) return
    if (before.trim()) c().insertContentAt({ from: from, to: from }, before.endsWith(' ') ? '>> ' : ' >> ').run()
    else c().insertContentAt({ from: to, to }, ' >> ').run()
  }
  const link = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const href = prompt(t('Link-Adresse'), prev ?? 'https://')
    if (href === null) return
    if (!href) c().unsetLink().run()
    else c().extendMarkRange('link').setLink({ href }).run()
  }
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatMenu"
      shouldShow={({ editor: e, from, to }) =>
        from !== to &&
        !(e.state.selection instanceof NodeSelection) && // a whole block picked via the handle
        !e.isActive('codeBlock') &&
        !e.isActive('image') &&
        !e.isActive('mermaid')
      }
    >
      <div className="bubble">
        <Btn on={s.bold} title={t('Fett (Strg+B)')} run={() => c().toggleBold().run()}><b>B</b></Btn>
        <Btn on={s.italic} title={t('Kursiv (Strg+I)')} run={() => c().toggleItalic().run()}><i>I</i></Btn>
        <Btn on={s.underline} title={t('Unterstrichen (Strg+U)')} run={() => c().toggleUnderline().run()}><u>U</u></Btn>
        <Btn on={s.strike} title={t('Durchgestrichen')} run={() => c().toggleStrike().run()}><s>S</s></Btn>
        <Btn on={s.code} title="Code" run={() => c().toggleCode().run()}>{'<>'}</Btn>
        <Btn on={s.highlight} title={t('Markieren')} run={() => c().toggleHighlight().run()}><span className="hl">M</span></Btn>
        <Btn title="Link" run={link}>↗</Btn>
        <span className="sep" />
        <span className="bubble-type">
          <Btn title={t('Block umwandeln')} run={() => setTypeOpen((o) => !o)}>
            {TARGETS.find((x) => x.id === s.type)?.label ?? t('Text')} ▾
          </Btn>
          {typeOpen && (
            <span className="bubble-type-list">
              {TARGETS.map((x) => (
                <Btn key={x.id} on={x.id === s.type} title={x.label} run={() => { applyTarget(c(), x.id).run(); setTypeOpen(false) }}>
                  <span className="bm-icon">{x.icon}</span>{x.label}
                </Btn>
              ))}
            </span>
          )}
        </span>
        <span className="sep" />
        <Btn title={t('Als Lücke abdecken {{ }}')} run={cloze}>{t('Lücke')}</Btn>
        <Btn title={t('Zeile zur Karteikarte machen: Auswahl wird zur Antwort')} run={toCard}>{t('Karte')}</Btn>
      </div>
    </BubbleMenu>
  )
}

function TableMenu({ editor }: { editor: Editor }) {
  const c = () => editor.chain().focus()
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      options={{ placement: 'top-start' }}
      shouldShow={({ editor: e, from, to }) => e.isActive('table') && from === to}
    >
      <div className="bubble">
        <Btn title={t('Zeile darunter')} run={() => c().addRowAfter().run()}>{t('+ Zeile')}</Btn>
        <Btn title={t('Spalte rechts')} run={() => c().addColumnAfter().run()}>{t('+ Spalte')}</Btn>
        <span className="sep" />
        <Btn title={t('Zeile löschen')} run={() => c().deleteRow().run()}>{t('− Zeile')}</Btn>
        <Btn title={t('Spalte löschen')} run={() => c().deleteColumn().run()}>{t('− Spalte')}</Btn>
        <span className="sep" />
        <Btn title={t('Tabelle löschen')} run={() => c().deleteTable().run()}>{t('Löschen')}</Btn>
      </div>
    </BubbleMenu>
  )
}

function Btn(p: { on?: boolean; title: string; run: () => void; children: React.ReactNode }) {
  return (
    <button
      className={p.on ? 'on' : ''}
      title={p.title}
      onMouseDown={(e) => {
        e.preventDefault()
        p.run()
      }}
    >
      {p.children}
    </button>
  )
}

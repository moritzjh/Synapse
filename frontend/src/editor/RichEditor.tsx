import { useRef } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { Mermaid } from './Mermaid'
import { OcclusionImage } from './OcclusionImage'
import { Callout, PageLink } from './blocks'
import { Database } from './database/Database'
import type { NoteSummary } from '../api'
import { SyntaxHighlight } from './syntax'
import { SlashCommands, WikilinkSuggest } from './commands'
import { insertImages } from './upload'
import type { Doc } from './doc'

const lowlight = createLowlight(common)

export { toDoc } from './doc'
export type { Doc } from './doc'

interface Props {
  initial: Doc
  onChange: (doc: Doc) => void
  onOpenLink: (title: string) => void
  onOpenNote: (id: number) => void
  onCreateSubpage: (title: string) => Promise<{ id: number; title: string }>
  getNotes: () => NoteSummary[]
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
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
      Mermaid,
      Callout,
      Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }),
      DetailsSummary,
      DetailsContent,
      Database,
      PageLink.configure({ getNotes: () => cb.current.getNotes(), onOpenNote: (id) => cb.current.onOpenNote(id) }),
      Placeholder.configure({
        includeChildren: true,
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? 'Überschrift' : node.type.name === 'detailsSummary' ? 'Titel' : 'Schreibe, oder tippe / für Blöcke',
      }),
      SyntaxHighlight.configure({ onOpenLink: (t) => cb.current.onOpenLink(t), getNotes: () => cb.current.getNotes() }),
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
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      h2: e.isActive('heading', { level: 2 }),
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
    const href = prompt('Link-Adresse', prev ?? 'https://')
    if (href === null) return
    if (!href) c().unsetLink().run()
    else c().extendMarkRange('link').setLink({ href }).run()
  }
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatMenu"
      shouldShow={({ editor: e, from, to }) =>
        from !== to && !e.isActive('codeBlock') && !e.isActive('image') && !e.isActive('mermaid')
      }
    >
      <div className="bubble">
        <Btn on={s.bold} title="Fett (Strg+B)" run={() => c().toggleBold().run()}><b>B</b></Btn>
        <Btn on={s.italic} title="Kursiv (Strg+I)" run={() => c().toggleItalic().run()}><i>I</i></Btn>
        <Btn on={s.underline} title="Unterstrichen (Strg+U)" run={() => c().toggleUnderline().run()}><u>U</u></Btn>
        <Btn on={s.strike} title="Durchgestrichen" run={() => c().toggleStrike().run()}><s>S</s></Btn>
        <Btn on={s.code} title="Code" run={() => c().toggleCode().run()}>{'<>'}</Btn>
        <Btn on={s.highlight} title="Markieren" run={() => c().toggleHighlight().run()}><span className="hl">M</span></Btn>
        <Btn title="Link" run={link}>↗</Btn>
        <span className="sep" />
        <Btn on={s.h2} title="Überschrift" run={() => c().toggleHeading({ level: 2 }).run()}>H</Btn>
        <span className="sep" />
        <Btn title="Als Lücke abdecken {{ }}" run={cloze}>Lücke</Btn>
        <Btn title="Zeile zur Karteikarte machen: Auswahl wird zur Antwort" run={toCard}>Karte</Btn>
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
        <Btn title="Zeile darunter" run={() => c().addRowAfter().run()}>+ Zeile</Btn>
        <Btn title="Spalte rechts" run={() => c().addColumnAfter().run()}>+ Spalte</Btn>
        <span className="sep" />
        <Btn title="Zeile löschen" run={() => c().deleteRow().run()}>− Zeile</Btn>
        <Btn title="Spalte löschen" run={() => c().deleteColumn().run()}>− Spalte</Btn>
        <span className="sep" />
        <Btn title="Tabelle löschen" run={() => c().deleteTable().run()}>Löschen</Btn>
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

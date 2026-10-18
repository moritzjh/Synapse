import { useRef } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { Mermaid, EXAMPLE_DIAGRAM } from './Mermaid'
import { SyntaxHighlight } from './syntax'
import { SlashCommands, WikilinkSuggest } from './commands'
import { insertImages, pickImages } from './upload'

const lowlight = createLowlight(common)

export type Doc = Record<string, unknown>

/** Accepts stored content (TipTap JSON or legacy plain text) and returns a document. */
export function toDoc(content: string): Doc {
  if (content.startsWith('{')) {
    try {
      const doc = JSON.parse(content)
      if (doc?.type === 'doc') return doc
    } catch {
      /* fall through: treat as text */
    }
  }
  const blocks: Doc[] = []
  let list: Doc[] | null = null
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^[-*] (.*)$/)
    const para = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })
    if (m) {
      if (!list) blocks.push({ type: 'bulletList', content: (list = []) })
      list.push({ type: 'listItem', content: [para(m[1])] })
    } else {
      list = null
      blocks.push(para(line))
    }
  }
  return { type: 'doc', content: blocks }
}

interface Props {
  initial: Doc
  onChange: (doc: Doc) => void
  onOpenLink: (title: string) => void
  getTitles: () => string[]
}

export default function RichEditor({ initial, onChange, onOpenLink, getTitles }: Props) {
  // Extensions are created once; route callbacks through refs so they stay current.
  const cb = useRef({ onChange, onOpenLink, getTitles })
  cb.current = { onChange, onOpenLink, getTitles }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true } }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: false }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
      Mermaid,
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === 'heading' ? 'Überschrift' : "Tippe '/' für Befehle, [[ für Links, >> für Karteikarten …",
      }),
      SyntaxHighlight.configure({ onOpenLink: (t) => cb.current.onOpenLink(t) }),
      SlashCommands,
      WikilinkSuggest.configure({ getTitles: () => cb.current.getTitles() }),
    ],
    content: initial,
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
    <div className="rich-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="rich-content" />
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      table: e.isActive('table'),
      hasSelection: !e.state.selection.empty,
    }),
  })

  const B = (p: { on?: boolean; title: string; run: () => void; children: React.ReactNode }) => (
    <button
      className={p.on ? 'tb on' : 'tb'}
      title={p.title}
      onMouseDown={(e) => {
        e.preventDefault()
        p.run()
      }}
    >
      {p.children}
    </button>
  )
  const c = () => editor.chain().focus()

  const cloze = () => {
    const { from, to, empty } = editor.state.selection
    if (empty) return c().insertContent('{{}}').setTextSelection(from + 2).run()
    const text = editor.state.doc.textBetween(from, to)
    c().insertContentAt({ from, to }, `{{${text}}}`).run()
  }

  return (
    <div className="toolbar-rich">
      <B on={s.bold} title="Fett (Strg+B)" run={() => c().toggleBold().run()}><b>B</b></B>
      <B on={s.italic} title="Kursiv (Strg+I)" run={() => c().toggleItalic().run()}><i>I</i></B>
      <B on={s.underline} title="Unterstrichen (Strg+U)" run={() => c().toggleUnderline().run()}><u>U</u></B>
      <B on={s.strike} title="Durchgestrichen" run={() => c().toggleStrike().run()}><s>S</s></B>
      <B on={s.highlight} title="Markieren" run={() => c().toggleHighlight().run()}><span className="hl">M</span></B>
      <B on={s.code} title="Inline-Code" run={() => c().toggleCode().run()}>{'`'}</B>
      <span className="sep" />
      <B on={s.h1} title="Überschrift 1" run={() => c().toggleHeading({ level: 1 }).run()}>H1</B>
      <B on={s.h2} title="Überschrift 2" run={() => c().toggleHeading({ level: 2 }).run()}>H2</B>
      <B on={s.h3} title="Überschrift 3" run={() => c().toggleHeading({ level: 3 }).run()}>H3</B>
      <span className="sep" />
      <B on={s.bullet} title="Aufzählung" run={() => c().toggleBulletList().run()}>•</B>
      <B on={s.ordered} title="Nummerierte Liste" run={() => c().toggleOrderedList().run()}>1.</B>
      <B on={s.task} title="To-do-Liste" run={() => c().toggleTaskList().run()}>☑</B>
      <B on={s.quote} title="Zitat" run={() => c().toggleBlockquote().run()}>❝</B>
      <B on={s.codeBlock} title="Codeblock" run={() => c().toggleCodeBlock().run()}>{'</>'}</B>
      <span className="sep" />
      <B title="Tabelle einfügen" run={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦</B>
      <B title="Bild einfügen" run={() => pickImages(editor)}>🖼</B>
      <B title="Diagramm einfügen" run={() => c().insertContent([{ type: 'mermaid', attrs: { code: EXAMPLE_DIAGRAM } }, { type: 'paragraph' }]).run()}>◇</B>
      <span className="sep" />
      <B title="Karteikarte (>>)" run={() => c().insertContent(' >> ').run()}>⇄</B>
      <B title="Lückentext: Auswahl abdecken {{ }}" run={cloze}>▭</B>
      {s.table && (
        <>
          <span className="sep" />
          <B title="Zeile darunter" run={() => c().addRowAfter().run()}>+Z</B>
          <B title="Spalte rechts" run={() => c().addColumnAfter().run()}>+S</B>
          <B title="Zeile löschen" run={() => c().deleteRow().run()}>−Z</B>
          <B title="Spalte löschen" run={() => c().deleteColumn().run()}>−S</B>
          <B title="Tabelle löschen" run={() => c().deleteTable().run()}>✕</B>
        </>
      )}
    </div>
  )
}

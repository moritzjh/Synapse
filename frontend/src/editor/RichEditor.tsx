import { useRef } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { Mermaid } from './Mermaid'
import { SyntaxHighlight } from './syntax'
import { SlashCommands, WikilinkSuggest } from './commands'
import { insertImages } from './upload'

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
          node.type.name === 'heading' ? 'Überschrift' : "Schreibe, oder tippe / für Blöcke",
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

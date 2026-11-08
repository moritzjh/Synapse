import { useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Extension, type Editor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Notion-style block handle: hovering a block shows "+" (insert a block
 * below, opens the / menu) and "⋮⋮" (drag to move, click for a menu with
 * "Turn into", duplicate, move and delete).
 */

const LIST_ITEMS = new Set(['listItem', 'taskItem'])

interface Block {
  pos: number
  node: PMNode
}

/** The block under a document position: the innermost list item, else the top-level node. */
function blockAt(view: EditorView, pos: number): Block | null {
  const { doc } = view.state
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  if ($pos.depth === 0) {
    const node = doc.nodeAt($pos.pos)
    return node ? { pos: $pos.pos, node } : null
  }
  for (let d = $pos.depth; d > 1; d--) {
    const n = $pos.node(d)
    if (LIST_ITEMS.has(n.type.name)) return { pos: $pos.before(d), node: n }
  }
  return { pos: $pos.before(1), node: $pos.node(1) }
}

/** Position inside the first textblock of a block, for running block commands on it. */
function textPosIn(block: Block): number | null {
  if (block.node.isTextblock) return block.pos + 1
  let found: number | null = null
  block.node.descendants((n, p) => {
    if (found !== null) return false
    if (n.isTextblock) {
      found = block.pos + 1 + p + 1
      return false
    }
  })
  return found
}

export type Target = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'ordered' | 'task' | 'toggle' | 'quote' | 'callout' | 'code'

export const TARGETS: { id: Target; label: string; icon: string; key?: string }[] = [
  { id: 'text', label: 'Text', icon: '¶' },
  { id: 'h1', label: 'Überschrift 1', icon: 'H1', key: '#' },
  { id: 'h2', label: 'Überschrift 2', icon: 'H2', key: '##' },
  { id: 'h3', label: 'Überschrift 3', icon: 'H3', key: '###' },
  { id: 'bullet', label: 'Aufzählung', icon: '•', key: '-' },
  { id: 'ordered', label: 'Nummerierte Liste', icon: '1.', key: '1.' },
  { id: 'task', label: 'To-do', icon: '☑', key: '[]' },
  { id: 'toggle', label: 'Aufklappbar', icon: '▸' },
  { id: 'quote', label: 'Zitat', icon: '❝', key: '>' },
  { id: 'callout', label: 'Callout', icon: '✦' },
  { id: 'code', label: 'Code', icon: '</>', key: '```' },
]

function currentTarget(block: Block): Target | null {
  const n = block.node
  switch (n.type.name) {
    case 'heading':
      return `h${n.attrs.level}` as Target
    case 'paragraph':
      return 'text'
    case 'codeBlock':
      return 'code'
    case 'blockquote':
      return 'quote'
    case 'callout':
      return 'callout'
    case 'details':
      return 'toggle'
    case 'taskItem':
      return 'task'
    case 'listItem':
      return null // bullet or numbered: decided by the parent list
  }
  return null
}

export function turnInto(editor: Editor, block: Block, target: Target) {
  const at = textPosIn(block)
  if (at === null) return
  applyTarget(editor.chain().focus().setTextSelection(at), target).run()
}

/** Turns the selected blocks into `target` (used by the block menu and the selection bubble). */
export function applyTarget(chain: ReturnType<Editor['chain']>, target: Target) {
  const c = chain.clearNodes()
  switch (target) {
    case 'h1':
    case 'h2':
    case 'h3':
      c.setHeading({ level: Number(target[1]) as 1 | 2 | 3 })
      break
    case 'bullet':
      c.toggleBulletList()
      break
    case 'ordered':
      c.toggleOrderedList()
      break
    case 'task':
      c.toggleTaskList()
      break
    case 'quote':
      c.toggleBlockquote()
      break
    case 'code':
      c.setCodeBlock()
      break
    case 'toggle':
      c.setDetails()
      break
    case 'callout':
      c.wrapIn('callout', { kind: 'tip' })
      break
  }
  return c
}

function duplicate(editor: Editor, b: Block) {
  editor.view.dispatch(editor.state.tr.insert(b.pos + b.node.nodeSize, b.node))
}

function remove(editor: Editor, b: Block) {
  editor.view.dispatch(editor.state.tr.delete(b.pos, b.pos + b.node.nodeSize))
  editor.commands.focus()
}

function move(editor: Editor, b: Block, dir: -1 | 1) {
  const { state } = editor
  const $pos = state.doc.resolve(b.pos)
  const index = $pos.index()
  const sibling = $pos.parent.maybeChild(index + dir)
  if (!sibling) return
  const tr = state.tr.delete(b.pos, b.pos + b.node.nodeSize)
  const to = dir < 0 ? b.pos - sibling.nodeSize : b.pos + sibling.nodeSize
  tr.insert(to, b.node)
  tr.setSelection(NodeSelection.create(tr.doc, to))
  editor.view.dispatch(tr.scrollIntoView())
}

/** "Text" → "Text >> " with the cursor after it, ready for the answer. */
function makeCard(editor: Editor, b: Block) {
  const at = textPosIn(b)
  if (at === null) return
  const tb = editor.state.doc.resolve(at).parent
  const end = at + tb.content.size
  const text = tb.textContent
  if (/\s(>>|::)(\s|$)/.test(text)) return
  editor.chain().focus().insertContentAt(end, text.endsWith(' ') ? '>> ' : ' >> ').run()
}

interface MenuProps {
  editor: Editor
  block: Block
  x: number
  y: number
  close: () => void
}

function BlockMenu({ editor, block, x, y, close }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const listType = editor.state.doc.resolve(block.pos).parent.type.name
  const current = currentTarget(block) ?? (listType === 'orderedList' ? 'ordered' : listType === 'bulletList' ? 'bullet' : null)
  const textual = textPosIn(block) !== null && !['database', 'mermaid', 'image', 'pageLink', 'table'].includes(block.node.type.name)
  const $pos = editor.state.doc.resolve(block.pos)

  useEffect(() => {
    const out = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', out)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', out)
      window.removeEventListener('keydown', esc)
    }
  }, [close])

  const run = (fn: () => void) => () => {
    fn()
    close()
  }
  const top = Math.min(y, window.innerHeight - 470)

  return (
    <div className="block-menu" ref={ref} style={{ left: x, top: Math.max(8, top) }}>
      {textual && (
        <>
          <div className="block-menu-label">Umwandeln in</div>
          {TARGETS.map((t) => (
            <button key={t.id} className={current === t.id ? 'on' : ''} onClick={run(() => turnInto(editor, block, t.id))}>
              <span className="bm-icon">{t.icon}</span>
              {t.label}
              {t.key && <kbd>{t.key}</kbd>}
            </button>
          ))}
          <hr />
          <button onClick={run(() => makeCard(editor, block))}>
            <span className="bm-icon">→</span>Als Karteikarte<kbd>&gt;&gt;</kbd>
          </button>
        </>
      )}
      <button onClick={run(() => duplicate(editor, block))}>
        <span className="bm-icon">⧉</span>Duplizieren
      </button>
      <button disabled={$pos.index() === 0} onClick={run(() => move(editor, block, -1))}>
        <span className="bm-icon">↑</span>Nach oben
      </button>
      <button disabled={$pos.index() >= $pos.parent.childCount - 1} onClick={run(() => move(editor, block, 1))}>
        <span className="bm-icon">↓</span>Nach unten
      </button>
      <hr />
      <button className="danger" onClick={run(() => remove(editor, block))}>
        <span className="bm-icon">✕</span>Löschen
      </button>
    </div>
  )
}

class HandleView {
  private el: HTMLDivElement
  private block: Block | null = null
  private menuHost: HTMLDivElement | null = null
  private menuRoot: Root | null = null
  private host: HTMLElement
  private dragging = false
  private view: EditorView
  private editor: Editor

  constructor(view: EditorView, editor: Editor) {
    this.view = view
    this.editor = editor
    this.host = (view.dom.closest('.page') as HTMLElement | null) ?? view.dom.parentElement!
    this.el = document.createElement('div')
    this.el.className = 'block-handle'
    this.el.innerHTML =
      '<button class="bh-add" title="Klicken: Block darunter einfügen" tabindex="-1">' +
      '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>' +
      '<button class="bh-drag" draggable="true" title="Ziehen: verschieben\nKlicken: Menü" tabindex="-1">' +
      '<svg viewBox="0 0 16 16"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/>' +
      '<circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg></button>'
    document.body.appendChild(this.el)

    this.el.querySelector('.bh-add')!.addEventListener('mousedown', (e) => e.preventDefault())
    this.el.querySelector('.bh-add')!.addEventListener('click', () => this.insertBelow())
    const drag = this.el.querySelector('.bh-drag') as HTMLElement
    drag.addEventListener('click', () => this.openMenu())
    drag.addEventListener('dragstart', (e) => this.onDragStart(e as DragEvent))
    drag.addEventListener('dragend', () => {
      this.dragging = false
      // ProseMirror only clears this for drags that started inside the editor
      setTimeout(() => (this.view.dragging = null), 50)
      this.hide()
    })

    this.host.addEventListener('mousemove', this.onMove)
    this.host.addEventListener('mouseleave', this.onLeave)
    view.dom.addEventListener('keydown', this.onKey)
    this.host.closest('.scroll')?.addEventListener('scroll', this.onScroll, { passive: true })
  }

  private onMove = (e: MouseEvent) => {
    if (this.dragging || this.menuHost || !this.editor.isEditable) return
    const r = this.view.dom.getBoundingClientRect()
    if (e.clientY < r.top || e.clientY > r.bottom || e.clientX > r.right + 20) return this.hide()
    const found = this.view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 24), r.right - 4), top: e.clientY })
    if (!found) return
    const block = blockAt(this.view, found.inside >= 0 ? found.inside : found.pos)
    if (!block) return this.hide()
    this.block = block
    this.place()
  }

  private onLeave = (e: MouseEvent) => {
    if (!this.el.contains(e.relatedTarget as Node)) this.hide()
  }
  private onKey = () => this.hide()
  private onScroll = () => {
    if (!this.menuHost) this.hide()
  }

  private place() {
    const b = this.block
    if (!b) return
    const dom = this.view.nodeDOM(b.pos) as HTMLElement | null
    if (!dom?.getBoundingClientRect) return this.hide()
    const rect = dom.getBoundingClientRect()
    // Centre on the first line of text, like Notion; atoms (images, tables …) align to their top.
    let mid = rect.top + 14
    const at = textPosIn(b)
    if (at !== null && !['table', 'database'].includes(b.node.type.name)) {
      try {
        const c = this.view.coordsAtPos(at)
        mid = (c.top + c.bottom) / 2
      } catch {
        /* keep top */
      }
    }
    const isItem = LIST_ITEMS.has(b.node.type.name)
    this.el.style.left = `${rect.left - (isItem ? 22 : 0) - 50}px`
    this.el.style.top = `${mid - 12}px`
    this.el.classList.add('visible')
  }

  private hide() {
    this.el.classList.remove('visible')
  }

  private insertBelow() {
    const b = this.block
    if (!b) return
    const isItem = LIST_ITEMS.has(b.node.type.name)
    const after = b.pos + b.node.nodeSize
    const { schema } = this.view.state
    const node = isItem
      ? b.node.type.create(b.node.type.name === 'taskItem' ? { checked: false } : null, schema.nodes.paragraph.create())
      : schema.nodes.paragraph.create()
    const tr = this.view.state.tr.insert(after, node)
    this.view.dispatch(tr)
    // put the cursor in the new block and open the / menu (not for list items: they just get a new bullet)
    const chain = this.editor.chain().focus().setTextSelection(after + (isItem ? 2 : 1))
    if (!isItem) chain.insertContent('/')
    chain.run()
    this.hide()
  }

  private onDragStart(e: DragEvent) {
    const b = this.block
    if (!b || !e.dataTransfer) return
    this.dragging = true
    const { view } = this
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, b.pos)))
    const slice = view.state.selection.content()
    // Only a private type: the block can be dropped inside the editor (ProseMirror reads view.dragging),
    // but not as stray text into the title field or another app.
    e.dataTransfer.clearData()
    e.dataTransfer.setData('application/x-synapse-block', '')
    e.dataTransfer.effectAllowed = 'move'
    const blockDom = view.nodeDOM(b.pos) as HTMLElement | null
    if (blockDom) e.dataTransfer.setDragImage(blockDom, 0, 0)
    view.dragging = { slice, move: true }
  }

  private openMenu() {
    const b = this.block
    if (!b) return
    this.closeMenu()
    const r = this.el.getBoundingClientRect()
    this.menuHost = document.createElement('div')
    document.body.appendChild(this.menuHost)
    this.menuRoot = createRoot(this.menuHost)
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, b.pos)))
    // like Notion: the menu opens to the left of the handle, so the block itself stays visible
    const x = r.left - 244 > 8 ? r.left - 244 : r.right + 4
    this.menuRoot.render(<BlockMenu editor={this.editor} block={b} x={x} y={r.top} close={() => this.closeMenu()} />)
  }

  private closeMenu() {
    const root = this.menuRoot
    const host = this.menuHost
    this.menuRoot = null
    this.menuHost = null
    setTimeout(() => {
      root?.unmount()
      host?.remove()
    })
    this.hide()
  }

  update() {
    if (this.block && this.el.classList.contains('visible')) {
      // the document changed under the handle: re-resolve so positions stay valid
      const size = this.view.state.doc.content.size
      if (this.block.pos >= size) return this.hide()
      const atom = this.view.state.doc.nodeAt(this.block.pos)?.isAtom
      const b = blockAt(this.view, atom ? this.block.pos : this.block.pos + 1)
      if (b) {
        this.block = b
        this.place()
      }
    }
  }

  destroy() {
    this.host.removeEventListener('mousemove', this.onMove)
    this.host.removeEventListener('mouseleave', this.onLeave)
    this.view.dom.removeEventListener('keydown', this.onKey)
    this.host.closest('.scroll')?.removeEventListener('scroll', this.onScroll)
    this.closeMenu()
    this.el.remove()
  }
}

export const BlockHandle = Extension.create({
  name: 'blockHandle',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('blockHandle'),
        view: (view) => new HandleView(view, editor),
      }),
    ]
  },
})

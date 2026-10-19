import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { Icon } from '../components/Icons'
import type { NoteSummary } from '../api'

export interface PageLinkOptions {
  getNotes: () => NoteSummary[]
  onOpenNote: (id: number) => void
}

function PageLinkView({ node, extension, selected }: ReactNodeViewProps) {
  const opts = extension.options as PageLinkOptions
  const note = opts.getNotes().find((n) => n.id === node.attrs.noteId)
  return (
    <NodeViewWrapper
      className={`page-link ${selected ? 'selected' : ''} ${note ? '' : 'missing'}`}
      contentEditable={false}
      onClick={() => note && opts.onOpenNote(note.id)}
      data-drag-handle
    >
      <Icon name="note" />
      <span>{note?.title ?? node.attrs.title ?? 'Gelöschte Seite'}</span>
    </NodeViewWrapper>
  )
}

/** Notion-style subpage block: a link to a child note shown as its own row. */
export const PageLink = Node.create<PageLinkOptions>({
  name: 'pageLink',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions() {
    return { getNotes: () => [], onOpenNote: () => {} }
  },
  addAttributes() {
    return { noteId: { default: null }, title: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-page-link]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-link': '' })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView)
  },
})

export const CALLOUTS = {
  note: { icon: '✎', label: 'Notiz' },
  tip: { icon: '✦', label: 'Tipp' },
  info: { icon: 'i', label: 'Info' },
  warning: { icon: '!', label: 'Achtung' },
  important: { icon: '★', label: 'Wichtig' },
} as const
type CalloutKind = keyof typeof CALLOUTS

function CalloutView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const kind = (node.attrs.kind in CALLOUTS ? node.attrs.kind : 'note') as CalloutKind
  const kinds = Object.keys(CALLOUTS) as CalloutKind[]
  return (
    <NodeViewWrapper className={`callout callout-${kind}`}>
      <button
        className="callout-icon"
        contentEditable={false}
        title={`${CALLOUTS[kind].label} – klicken zum Wechseln`}
        onClick={() => editor.isEditable && updateAttributes({ kind: kinds[(kinds.indexOf(kind) + 1) % kinds.length] })}
      >
        {CALLOUTS[kind].icon}
      </button>
      <NodeViewContent className="callout-body" />
    </NodeViewWrapper>
  )
}

/** Highlighted box (Notion callout, Obsidian "> [!tip]"). */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { kind: { default: 'note' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]', getAttrs: (el) => ({ kind: (el as HTMLElement).dataset.callout }) }]
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': node.attrs.kind }), 0]
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
})

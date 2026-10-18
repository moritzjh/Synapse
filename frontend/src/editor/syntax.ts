import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export interface SyntaxOptions {
  onOpenLink: (title: string) => void
}

const WIKILINK = /\[\[([^\]\n]+?)\]\]/g
const CLOZE = /\{\{([^}\n]+?)\}\}/g
const SEPARATOR = /(?<= )(>>|::)(?= |$)/g

function decorate(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isText || !node.text) return
    if (node.marks.some((m) => m.type.name === 'code')) return
    const text = node.text
    for (const m of text.matchAll(WIKILINK)) {
      const target = m[1].split(/[|#]/)[0].trim()
      decos.push(
        Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, {
          class: 'wikilink',
          'data-target': target,
        }),
      )
    }
    for (const m of text.matchAll(CLOZE)) {
      decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'cloze-mark' }))
    }
    for (const m of text.matchAll(SEPARATOR)) {
      decos.push(Decoration.inline(pos + m.index!, pos + m.index! + m[0].length, { class: 'card-sep' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

/**
 * Highlights [[wikilinks]] (clickable), {{cloze}} gaps and the >> / ::
 * flashcard separators so you can see which lines become cards.
 */
export const SyntaxHighlight = Extension.create<SyntaxOptions>({
  name: 'synapseSyntax',
  addOptions() {
    return { onOpenLink: () => {} }
  },
  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey('synapseSyntax'),
        state: {
          init: (_, { doc }) => decorate(doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state)
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest('.wikilink') as HTMLElement | null
            if (el && (event.metaKey || event.ctrlKey || !_view.editable)) {
              options.onOpenLink(el.dataset.target!)
              return true
            }
            return false
          },
          handleDoubleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest('.wikilink') as HTMLElement | null
            if (el) {
              options.onOpenLink(el.dataset.target!)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})

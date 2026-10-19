import { Extension, InputRule } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/** Distance the caret keeps from the top and bottom edge of the scrolling page. */
const CARET_MARGIN = 120

/**
 * Keeps the caret comfortably inside the visible page while moving with the
 * arrow keys or typing – the browser would only scroll once it touches the edge.
 */
export const CaretMargin = Extension.create({
  name: 'caretMargin',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('caretMargin'),
        view: (view) => {
          // The DOM caret is what the user sees; ProseMirror's state can lag behind native arrow-key moves.
          const caretRect = () => {
            const sel = window.getSelection()
            if (sel?.rangeCount && view.dom.contains(sel.focusNode)) {
              const r = sel.getRangeAt(0).cloneRange()
              r.collapse(false)
              const rect = r.getBoundingClientRect()
              if (rect.height) return rect
            }
            try {
              return view.coordsAtPos(view.state.selection.head)
            } catch {
              return null
            }
          }
          const keep = () => {
            const scroller = view.dom.closest('.scroll')
            const caret = caretRect()
            if (!scroller || !caret) return
            const box = scroller.getBoundingClientRect()
            const margin = Math.min(CARET_MARGIN, box.height / 4)
            if (caret.bottom > box.bottom - margin) scroller.scrollTop += caret.bottom - (box.bottom - margin)
            else if (caret.top < box.top + margin && scroller.scrollTop > 0) scroller.scrollTop -= box.top + margin - caret.top
          }
          const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if (/^(Arrow(Up|Down)|Page(Up|Down)|Enter|Backspace)$/.test(e.key) || e.key.length === 1)
              requestAnimationFrame(keep)
          }
          // keydown fires before the caret moves, keyup after it – check after both
          view.dom.addEventListener('keydown', onKey)
          view.dom.addEventListener('keyup', onKey)
          return {
            destroy: () => {
              view.dom.removeEventListener('keydown', onKey)
              view.dom.removeEventListener('keyup', onKey)
            },
          }
        },
      }),
    ]
  },
})

/**
 * Makes flashcards quick to type:
 *  - "Frage>>" gets the spaces the card syntax needs ("Frage >> ")
 *  - Enter after "Frage >>" starts the answer list right away (a list card)
 */
export const CardTyping = Extension.create({
  name: 'cardTyping',
  priority: 200, // before the list keymaps
  addInputRules() {
    return [
      new InputRule({
        find: /([^\s>])>>$/,
        handler: ({ state, range, match }) => {
          const $pos = state.doc.resolve(range.from)
          if ($pos.parent.type.spec.code || state.schema.marks.code?.isInSet($pos.marks())) return null
          state.tr.insertText(`${match[1]} >> `, range.from, range.to)
        },
      }),
    ]
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cardTypingSpace'),
        props: {
          // "Frage >> " already ends with a space – don't double it.
          handleTextInput: (view, from, to, text) => {
            if (text !== ' ' || from !== to) return false
            const $from = view.state.doc.resolve(from)
            const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 4), $from.parentOffset)
            return before === ' >> ' && $from.parentOffset === $from.parent.content.size
          },
        },
      }),
    ]
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { selection } = editor.state
        const { $from, empty } = selection
        if (!empty || $from.parent.type.spec.code || $from.parentOffset !== $from.parent.content.size) return false
        if (!/\s>>\s*$/.test($from.parent.textContent)) return false
        // trailing space from "Frage >> " would make the line look like it has an empty answer
        const text = $from.parent.textContent
        const trailing = text.length - text.trimEnd().length
        const chain = editor.chain()
        if (trailing) chain.deleteRange({ from: $from.pos - trailing, to: $from.pos })
        const inItem = $from.depth >= 2 && /^(listItem|taskItem)$/.test($from.node(-1).type.name)
        if (inItem) {
          const item = $from.node(-1).type.name
          // already has an answer list below → normal Enter
          if ($from.node(-1).childCount > 1) return false
          return chain.splitListItem(item).sinkListItem(item).run()
        }
        const parent = $from.node(-1)
        const next = $from.indexAfter(-1) < parent.childCount ? parent.child($from.indexAfter(-1)) : null
        if (next && /List$/.test(next.type.name)) return false
        return chain.splitBlock().toggleBulletList().run()
      },
    }
  },
})

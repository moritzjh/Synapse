import { InputRule, type Editor } from '@tiptap/core'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import katex from 'katex'

/**
 * LaTeX formulas, written like in Obsidian:
 *   $E = mc^2$     inline (no space right inside the dollars, so "5$ and 10$" stays text)
 *   $$…$$          on a line of its own: a centred block
 * Clicking a formula opens a small editor with a live preview.
 */

let open: { el: HTMLDivElement; close: () => void } | null = null

export function editMath(editor: Editor, pos: number, block: boolean) {
  open?.close()
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null
  const rect = dom?.getBoundingClientRect() ?? editor.view.coordsAtPos(pos)

  const el = document.createElement('div')
  el.className = 'math-edit'
  const input = document.createElement('textarea')
  input.value = node.attrs.latex ?? ''
  input.rows = block ? 3 : 1
  input.spellcheck = false
  input.placeholder = block ? '\\int_0^1 x^2 \\, dx' : 'E = mc^2'
  const preview = document.createElement('div')
  preview.className = 'math-edit-preview'
  const hint = document.createElement('div')
  hint.className = 'math-edit-hint'
  hint.textContent = block ? 'Strg+Enter übernehmen · Esc abbrechen' : 'Enter übernehmen · Esc abbrechen'
  el.append(input, preview, hint)
  document.body.appendChild(el)
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 380))}px`
  el.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`

  const render = () => {
    try {
      katex.render(input.value || '\\;', preview, { throwOnError: true, displayMode: block })
      preview.classList.remove('error')
    } catch (e) {
      preview.textContent = (e as Error).message.replace(/^KaTeX parse error: /, '')
      preview.classList.add('error')
    }
  }
  render()

  const close = () => {
    el.remove()
    window.removeEventListener('mousedown', outside, true)
    open = null
  }
  const commit = () => {
    const latex = input.value.trim()
    const current = editor.state.doc.nodeAt(pos)
    close()
    if (!current || current.type !== node.type) return
    const tr = editor.state.tr
    if (!latex) tr.delete(pos, pos + current.nodeSize)
    else tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex })
    editor.view.dispatch(tr)
    editor.commands.focus(latex ? pos + current.nodeSize : pos)
  }
  const outside = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) commit()
  }

  input.addEventListener('input', render)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      editor.commands.focus()
    } else if (e.key === 'Enter' && (!block || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commit()
    }
  })
  window.addEventListener('mousedown', outside, true)
  open = { el, close }
  setTimeout(() => {
    input.focus()
    input.select()
  })
}

export const katexOptions = { throwOnError: false }

export const InlineFormula = InlineMath.extend({
  addInputRules() {
    return [
      new InputRule({
        // "$x$" just typed: the opening $ follows a space/start, the content does not start or end with a space
        find: /(^|[\s([{])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          const start = range.from + match[1].length
          state.tr.replaceWith(start, range.to, this.type.create({ latex: match[2] }))
        },
      }),
    ]
  },
})

export const BlockFormula = BlockMath.extend({
  addInputRules() {
    return [
      new InputRule({
        // a line that is only "$$…$$"
        find: /^\$\$([^$]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from)
          // only when the line holds nothing but the formula (text after the cursor stays a paragraph)
          if ($from.parent.textContent !== match[0] || $from.depth === 0) return null
          state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex: match[1].trim() }))
        },
      }),
    ]
  },
})

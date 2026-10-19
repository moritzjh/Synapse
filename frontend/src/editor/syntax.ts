import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { api, type NoteSummary } from '../api'
import { toDoc } from './doc'

export interface SyntaxOptions {
  onOpenLink: (title: string) => void
  getNotes: () => NoteSummary[]
}

/**
 * Live preview for the plain-text syntax Synapse stores (and Obsidian reads):
 *
 *   [[Note]] / [[Note|Alias]]   → link text only; brackets appear while the cursor is inside
 *   Question >> Answer          → card row with an arrow pill instead of ">>"
 *   Term :: Definition          → card row with a two-way pill
 *   Question >>  + list below   → list card, the list is marked as answers
 *   {{gap}}                     → highlighted gap without braces
 *
 * The source text never changes, so Markdown files stay readable and editable.
 */

const WIKILINK = /\[\[([^\]\n]+?)\]\]/g
const CLOZE = /\{\{([^}\n]+?)\}\}/g
const SEPARATORS = [
  { sep: '>>', kind: 'basic', pill: '→' },
  { sep: '::', kind: 'reverse', pill: '⇄' },
] as const

interface BlockText {
  text: string
  /** doc position of every character of `text` */
  pos: number[]
}

function blockText(node: PMNode, start: number): BlockText {
  let text = ''
  const pos: number[] = []
  node.forEach((child, offset) => {
    const at = start + 1 + offset
    if (child.isText) {
      if (child.marks.some((m) => m.type.name === 'code')) {
        // inline code is never syntax: mask it
        for (let i = 0; i < child.text!.length; i++) {
          text += '\u0000'
          pos.push(at + i)
        }
      } else {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i]
          pos.push(at + i)
        }
      }
    } else {
      text += '\n'
      pos.push(at)
    }
  })
  return { text, pos }
}

/** Same rule as the backend: the separator must stand on its own ("a >> b", "a >>"). */
function findSeparator(text: string, sep: string) {
  for (let i = text.indexOf(sep); i !== -1; i = text.indexOf(sep, i + 1)) {
    const after = i + sep.length
    if (i > 0 && text[i - 1] === ' ' && (after === text.length || text[after] === ' ' || text[after] === '\n')) return i
  }
  return -1
}

function pill(symbol: string, title: string) {
  const el = document.createElement('span')
  el.className = 'card-pill'
  el.textContent = symbol
  el.title = title
  el.contentEditable = 'false'
  return el
}

function decorate(state: EditorState, notes: NoteSummary[]): DecorationSet {
  const { doc, selection } = state
  const titles = new Set(notes.map((n) => n.title.toLowerCase()))
  const decos: Decoration[] = []
  const hide = (from: number, to: number) => from < to && decos.push(Decoration.inline(from, to, { class: 'syn-hide' }))
  const cursorIn = (from: number, to: number) => selection.from >= from && selection.to <= to

  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isTextblock) return
    const { text, pos: at } = blockText(node, pos)
    if (!text) return false
    const end = (i: number) => (i < at.length ? at[i] : pos + node.nodeSize - 1)
    const blockActive = cursorIn(pos, pos + node.nodeSize)

    // [[links]]
    for (const m of text.matchAll(WIKILINK)) {
      const s = m.index!, e = s + m[0].length
      const inner = m[1]
      const bar = inner.indexOf('|')
      const target = inner.split(/[|#]/)[0].trim()
      const resolved = titles.has(target.toLowerCase())
      const from = at[s], to = end(e)
      if (cursorIn(from, to)) {
        decos.push(Decoration.inline(from, to, { class: 'wikilink-raw' }))
        continue
      }
      const visibleStart = bar >= 0 ? s + 2 + bar + 1 : s + 2
      hide(at[s], at[visibleStart])
      hide(at[e - 2], to)
      decos.push(
        Decoration.inline(at[visibleStart], at[e - 2], {
          class: resolved ? 'wikilink' : 'wikilink unresolved',
          'data-target': target,
          title: resolved ? '' : `„${target}“ anlegen`,
        }),
      )
    }

    // {{cloze}}
    let hasCloze = false
    for (const m of text.matchAll(CLOZE)) {
      hasCloze = true
      const s = m.index!, e = s + m[0].length
      const from = at[s], to = end(e)
      if (cursorIn(from, to)) {
        decos.push(Decoration.inline(from, to, { class: 'cloze-raw' }))
        continue
      }
      hide(at[s], at[s + 2])
      hide(at[e - 2], to)
      decos.push(Decoration.inline(at[s + 2], at[e - 2], { class: 'cloze-mark' }))
    }

    // Question >> Answer / Term :: Definition
    const next = parent && index + 1 < parent.childCount ? parent.child(index + 1) : null
    let card: string | null = hasCloze ? 'cloze' : null
    if (!hasCloze) {
      for (const { sep, kind, pill: symbol } of SEPARATORS) {
        const i = findSeparator(text, sep)
        if (i < 0) continue
        const back = text.slice(i + sep.length).trim()
        const isList = !back && sep === '>>' && !!next && /List$/.test(next.type.name)
        if (!back && !isList) break
        card = isList ? 'list' : kind
        const sFrom = at[i], sTo = at[i + sep.length - 1] + 1
        if (blockActive) {
          decos.push(Decoration.inline(sFrom, sTo, { class: 'card-sep' }))
        } else {
          hide(sFrom, sTo)
          decos.push(
            Decoration.widget(sFrom, () => pill(isList ? '↓' : symbol, isList ? 'Listen-Karte' : kind === 'basic' ? 'Karteikarte' : 'Karte in beide Richtungen'), {
              side: -1,
              key: `pill-${card}`,
            }),
          )
        }
        if (i > 0) decos.push(Decoration.inline(at[0], sFrom, { class: 'card-q' }))
        if (back) decos.push(Decoration.inline(sTo, end(text.length), { class: 'card-a' }))
        if (isList) {
          const listPos = pos + node.nodeSize
          decos.push(Decoration.node(listPos, listPos + next!.nodeSize, { class: 'card-answers' }))
        }
        break
      }
    }
    if (card) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `card-line card-${card}` }))
    return false
  })
  return DecorationSet.create(doc, decos)
}

// ---- hover preview of linked notes ------------------------------------------------

const previewCache = new Map<number, string>()
let previewEl: HTMLDivElement | null = null
let previewTimer: ReturnType<typeof setTimeout> | undefined

function hidePreview() {
  clearTimeout(previewTimer)
  previewEl?.remove()
  previewEl = null
}

function showPreview(link: HTMLElement, notes: NoteSummary[]) {
  const target = link.dataset.target?.toLowerCase()
  const note = notes.find((n) => n.title.toLowerCase() === target)
  if (!note) return
  clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    let text = previewCache.get(note.id)
    if (text === undefined) {
      const full = await api.getNote(note.id).catch(() => null)
      text = full ? plain(toDoc(full.content)).slice(0, 420) : ''
      previewCache.set(note.id, text)
      setTimeout(() => previewCache.delete(note.id), 30_000)
    }
    hidePreview()
    const r = link.getBoundingClientRect()
    previewEl = document.createElement('div')
    previewEl.className = 'link-preview'
    const h = document.createElement('div')
    h.className = 'link-preview-title'
    h.textContent = note.title
    const p = document.createElement('div')
    p.className = 'link-preview-body'
    p.textContent = text || 'Leere Notiz'
    previewEl.append(h, p)
    previewEl.style.left = `${Math.min(r.left, window.innerWidth - 340)}px`
    previewEl.style.top = `${r.bottom + 8}px`
    document.body.appendChild(previewEl)
  }, 350)
}

function plain(node: unknown): string {
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return (n.text ?? '').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a).replace(/\{\{|\}\}/g, '')
  const inner = (n.content ?? []).map(plain).join('')
  return /paragraph|heading|listItem/.test(n.type ?? '') ? inner + ' ' : inner
}

export const SyntaxHighlight = Extension.create<SyntaxOptions>({
  name: 'synapseSyntax',
  addOptions() {
    return { onOpenLink: () => {}, getNotes: () => [] }
  },
  addProseMirrorPlugins() {
    const options = this.options
    const key = new PluginKey<DecorationSet>('synapseSyntax')
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state, options.getNotes()),
          apply: (tr, old, _o, state) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(key) ? decorate(state, options.getNotes()) : old,
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
          handleClick(_view: EditorView, _pos: number, event: MouseEvent) {
            const el = (event.target as HTMLElement).closest('.wikilink') as HTMLElement | null
            if (!el) return false
            hidePreview()
            options.onOpenLink(el.dataset.target!)
            return true
          },
          handleDOMEvents: {
            mouseover(_view, event) {
              const el = (event.target as HTMLElement).closest('.wikilink:not(.unresolved)') as HTMLElement | null
              if (el) showPreview(el, options.getNotes())
              return false
            },
            mouseout(_view, event) {
              if ((event.target as HTMLElement).closest('.wikilink')) hidePreview()
              return false
            },
          },
        },
      }),
    ]
  },
})

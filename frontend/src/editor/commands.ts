import { Extension, type Editor, type Range } from '@tiptap/core'
import { PluginKey, type EditorState } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { menuRenderer, type MenuItem } from './SuggestionMenu'
import { pickImages } from './upload'
import { EXAMPLE_DIAGRAM } from './Mermaid'
import { editMath } from './Math'
import { emptyDatabase, taskTracker } from './database/model'
import { t } from '../i18n'

export interface SlashOptions {
  createSubpage: (title: string) => Promise<{ id: number; title: string }>
}

interface SlashItem extends MenuItem {
  keywords: string
  /** German title: internal identifier, also searchable */
  de?: string
  run: (editor: Editor, range: Range, opts: SlashOptions) => void
}

const ITEMS: SlashItem[] = [
  { title: 'Text', icon: '¶', keywords: 'paragraph absatz', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { title: 'Überschrift 1', icon: 'H1', keywords: 'h1 heading title', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { title: 'Überschrift 2', icon: 'H2', keywords: 'h2 heading', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { title: 'Überschrift 3', icon: 'H3', keywords: 'h3 heading', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { title: 'Aufzählung', icon: '•', keywords: 'bullet list liste', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: 'Nummerierte Liste', icon: '1.', keywords: 'ordered numbered', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: 'To-do-Liste', icon: '☑', keywords: 'todo task checkbox aufgabe', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: 'Zitat', icon: '❝', keywords: 'quote blockquote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: 'Code', icon: '</>', keywords: 'code block snippet', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  {
    title: 'Tabelle', icon: '▦', keywords: 'table tabelle grid',
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { title: 'Bild', icon: '🖼', keywords: 'image bild foto upload', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickImages(e) } },
  {
    title: 'Diagramm', icon: '◇', keywords: 'diagram mermaid grafik chart flowchart',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent([{ type: 'mermaid', attrs: { code: EXAMPLE_DIAGRAM } }, { type: 'paragraph' }]).run(),
  },
  {
    title: 'Unterseite', icon: '❐', hint: 'neue Seite darin', keywords: 'page subpage seite unterseite',
    run: async (e, r, o) => {
      e.chain().focus().deleteRange(r).run()
      const title = prompt(t('Titel der Unterseite'), t('Neue Seite'))
      if (!title) return
      const note = await o.createSubpage(title)
      e.chain().focus().insertContent([{ type: 'pageLink', attrs: { noteId: note.id, title: note.title } }, { type: 'paragraph' }]).run()
    },
  },
  {
    title: 'Datenbank', icon: '▤', hint: 'Tabelle mit Eigenschaften', keywords: 'database datenbank tabelle table notion',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent([{ type: 'database', attrs: emptyDatabase() }, { type: 'paragraph' }]).run(),
  },
  {
    title: 'Task-Tracker', icon: '☑', hint: 'Status, Board, Diagramm', keywords: 'task tracker aufgaben todo kanban board',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent([{ type: 'database', attrs: taskTracker() }, { type: 'paragraph' }]).run(),
  },
  {
    title: 'Callout', icon: '✦', hint: 'hervorgehobener Kasten', keywords: 'callout hinweis box tipp info warnung note tip warning',
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertContent({ type: 'callout', attrs: { kind: 'tip' }, content: [{ type: 'paragraph' }] })
        .run(),
  },
  {
    title: 'Aufklappbar', icon: '▸', hint: 'Toggle', keywords: 'toggle details aufklappen collapse',
    run: (e, r) => e.chain().focus().deleteRange(r).setDetails().run(),
  },
  { title: 'Trennlinie', icon: '—', keywords: 'divider hr line', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  {
    title: 'Karteikarte', icon: '→', hint: 'Frage >> Antwort', keywords: 'flashcard karte card anki',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent(t('Frage >> Antwort')).run(),
  },
  {
    title: 'Listen-Karte', icon: '☰', hint: 'Punkte einzeln aufdecken', keywords: 'flashcard list multi liste',
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertContent([
          { type: 'paragraph', content: [{ type: 'text', text: t('Frage >>') }] },
          { type: 'bulletList', content: [1, 2, 3].map((n) => ({
              type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t('Punkt {n}', { n }) }] }] })) },
        ])
        .run(),
  },
  {
    title: 'Formel', icon: '∑', hint: '$E = mc^2$ im Text', keywords: 'math latex formel gleichung equation katex',
    run: (e, r) => {
      e.chain().focus().deleteRange(r).insertContent({ type: 'inlineMath', attrs: { latex: 'x' } }).run()
      editMath(e, e.state.selection.from - 1, false)
    },
  },
  {
    title: 'Formelblock', icon: '∫', hint: '$$ … $$ als eigene Zeile', keywords: 'math latex formel block display gleichung equation',
    run: (e, r) => {
      const at = r.from
      e.chain().focus().deleteRange(r).insertContent({ type: 'blockMath', attrs: { latex: 'x' } }).run()
      let found = -1
      e.state.doc.descendants((n, p) => {
        if (n.type.name === 'blockMath' && Math.abs(p - at) < 4) found = p
      })
      if (found >= 0) editMath(e, found, true)
    },
  },
  {
    title: 'Lückentext', icon: '▭', hint: '{{verdeckt}}', keywords: 'cloze lücke abdecken gap blank',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent(t('{{verdeckt}}')).run(),
  },
]

// Grouped like Notion's menu; `kbd` is the Markdown shortcut that does the same while typing.
const GROUPS: [string, string[]][] = [
  ['Grundblöcke', ['Text', 'Überschrift 1', 'Überschrift 2', 'Überschrift 3', 'Aufzählung', 'Nummerierte Liste', 'To-do-Liste', 'Aufklappbar', 'Zitat', 'Callout', 'Trennlinie', 'Code']],
  ['Karteikarten', ['Karteikarte', 'Listen-Karte', 'Lückentext']],
  ['Medien & Struktur', ['Formel', 'Formelblock', 'Bild', 'Tabelle', 'Diagramm', 'Unterseite', 'Datenbank', 'Task-Tracker']],
]
const KBD: Record<string, string> = {
  'Überschrift 1': '#', 'Überschrift 2': '##', 'Überschrift 3': '###', Aufzählung: '-', 'Nummerierte Liste': '1.',
  'To-do-Liste': '[]', Zitat: '>', Code: '```', Trennlinie: '---', Karteikarte: '>>', Lückentext: '{{ }}', Formel: '$ $', Formelblock: '$$',
}
// German titles are the identifiers above; the menu shows them translated.
const SLASH_ITEMS: SlashItem[] = GROUPS.flatMap(([group, titles]) =>
  titles.map((de) => {
    const item = ITEMS.find((i) => i.title === de)!
    const title = t(de)
    const hint = item.hint && t(item.hint) !== title ? t(item.hint) : undefined
    return { ...item, de, title, hint, group: t(group), kbd: KBD[de] }
  }),
)

/** Menus stay closed inside code blocks and inline code ("cd /usr", "m = [[1, 2]]"). */
function notInCode(state: EditorState, pos: number) {
  const $p = state.doc.resolve(pos)
  return !$p.parent.type.spec.code && !state.schema.marks.code?.isInSet($p.marks())
}

/** Notion-style "/" command menu. */
export const SlashCommands = Extension.create<SlashOptions>({
  name: 'slashCommands',
  addOptions() {
    return { createSubpage: async () => ({ id: 0, title: '' }) }
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slash'),
        char: '/',
        allow: ({ state, range }) => notInCode(state, range.from),
        items: ({ query }) => {
          const q = query.toLowerCase()
          // title prefix > title substring > keyword
          const rank = (i: SlashItem) => {
            const titles = [i.title, i.de ?? i.title].map((s) => s.toLowerCase())
            return titles.some((s) => s.startsWith(q)) ? 0 : titles.some((s) => s.includes(q)) ? 1 : i.keywords.includes(q) ? 2 : 9
          }
          return SLASH_ITEMS.map((item, idx) => ({ item, idx, r: rank(item) }))
            .filter((x) => x.r < 9)
            .sort((a, b) => a.r - b.r || a.idx - b.idx)
            .map((x) => x.item)
        },
        command: ({ editor, range, props }) => props.run(editor, range, this.options),
        render: menuRenderer<SlashItem>(t('Kein Befehl')),
      }),
    ]
  },
})

interface LinkItem extends MenuItem {
  create?: boolean
}

export interface WikilinkOptions {
  getTitles: () => string[]
}

/** Autocomplete for [[wikilinks]] with the titles of existing notes. */
export const WikilinkSuggest = Extension.create<WikilinkOptions>({
  name: 'wikilinkSuggest',
  addOptions() {
    return { getTitles: () => [] }
  },
  addProseMirrorPlugins() {
    const getTitles = this.options.getTitles
    return [
      Suggestion<LinkItem, LinkItem>({
        editor: this.editor,
        pluginKey: new PluginKey('wikilink'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        // Stop suggesting once the link is closed with "]]".
        allow: ({ state, range }) => notInCode(state, range.from) && !state.doc.textBetween(range.from, range.to).slice(2).includes(']'),
        items: ({ query }) => {
          const q = query.replace(/\]+$/, '').toLowerCase()
          const matches = getTitles()
            .filter((t) => t.toLowerCase().includes(q))
            .slice(0, 8)
            .map((title): LinkItem => ({ title, icon: '↗' }))
          if (q && !matches.some((m) => m.title.toLowerCase() === q))
            matches.push({ title: query.replace(/\]+$/, ''), icon: '+', hint: t('neue Notiz'), create: true })
          return matches
        },
        command: ({ editor, range, props }) => {
          // Swallow an auto-closed "]]" right after the cursor.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size))
          const to = after === ']]' ? range.to + 2 : range.to
          editor.chain().focus().insertContentAt({ from: range.from, to }, `[[${props.title}]] `).run()
        },
        render: menuRenderer<LinkItem>(t('Titel tippen…')),
      }),
    ]
  },
})

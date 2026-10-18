import { Extension, type Editor, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { menuRenderer, type MenuItem } from './SuggestionMenu'
import { pickImages } from './upload'
import { EXAMPLE_DIAGRAM } from './Mermaid'

interface SlashItem extends MenuItem {
  keywords: string
  run: (editor: Editor, range: Range) => void
}

const SLASH_ITEMS: SlashItem[] = [
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
  { title: 'Trennlinie', icon: '—', keywords: 'divider hr line', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  {
    title: 'Karteikarte', icon: '⇄', hint: 'Frage >> Antwort', keywords: 'flashcard karte card anki',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent('Frage >> Antwort').run(),
  },
  {
    title: 'Listen-Karte', icon: '☰', hint: 'Punkte einzeln aufdecken', keywords: 'flashcard list multi liste',
    run: (e, r) =>
      e.chain().focus().deleteRange(r)
        .insertContent([
          { type: 'paragraph', content: [{ type: 'text', text: 'Frage >>' }] },
          { type: 'bulletList', content: ['Punkt 1', 'Punkt 2', 'Punkt 3'].map((t) => ({
              type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) },
        ])
        .run(),
  },
  {
    title: 'Lückentext', icon: '▭', hint: '{{verdeckt}}', keywords: 'cloze lücke abdecken',
    run: (e, r) => e.chain().focus().deleteRange(r).insertContent('{{verdeckt}}').run(),
  },
]

/** Notion-style "/" command menu. */
export const SlashCommands = Extension.create({
  name: 'slashCommands',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slash'),
        char: '/',
        items: ({ query }) => {
          const q = query.toLowerCase()
          return SLASH_ITEMS.filter((i) => i.title.toLowerCase().includes(q) || i.keywords.includes(q))
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: menuRenderer<SlashItem>('Kein Befehl'),
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
        allow: ({ state, range }) => !state.doc.textBetween(range.from, range.to).slice(2).includes(']'),
        items: ({ query }) => {
          const q = query.replace(/\]+$/, '').toLowerCase()
          const matches = getTitles()
            .filter((t) => t.toLowerCase().includes(q))
            .slice(0, 8)
            .map((title): LinkItem => ({ title, icon: '↗' }))
          if (q && !matches.some((m) => m.title.toLowerCase() === q))
            matches.push({ title: query.replace(/\]+$/, ''), icon: '+', hint: 'neue Notiz', create: true })
          return matches
        },
        command: ({ editor, range, props }) => {
          // Swallow an auto-closed "]]" right after the cursor.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size))
          const to = after === ']]' ? range.to + 2 : range.to
          editor.chain().focus().insertContentAt({ from: range.from, to }, `[[${props.title}]] `).run()
        },
        render: menuRenderer<LinkItem>('Titel tippen…'),
      }),
    ]
  },
})

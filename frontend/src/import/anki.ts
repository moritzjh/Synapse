import { unzipSync } from 'fflate'
import { decompress } from 'fzstd'
import initSqlJs, { type Database } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

/**
 * Reads an Anki export (.apkg / .colpkg) in the browser – both the legacy
 * format (collection.anki2 / .anki21, plain media) and the current one
 * (collection.anki21b, zstd-compressed database and media).
 */

export interface AnkiCard {
  kind: 'basic' | 'reverse' | 'cloze'
  front: string
  back: string
  /** media file names referenced by the note */
  images: string[]
}

export interface AnkiDeck {
  /** deck path, e.g. ["Medizin", "Anatomie"] */
  path: string[]
  cards: AnkiCard[]
}

export interface AnkiPackage {
  decks: AnkiDeck[]
  media: Map<string, Uint8Array>
}

const isZstd = (b: Uint8Array) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd
const unz = (b: Uint8Array) => (isZstd(b) ? decompress(b) : b)

type Field = (field: number, value: number | Uint8Array) => void

/** Minimal protobuf reader: calls `on` for every field of a message. */
function readProto(b: Uint8Array, on: Field) {
  let i = 0
  const varint = () => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const byte = b[i++]
      v += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80 || i >= b.length) return v
    }
  }
  while (i < b.length) {
    const key = varint()
    const wire = key & 7
    if (wire === 0) on(key >>> 3, varint())
    else if (wire === 2) {
      const len = varint()
      on(key >>> 3, b.subarray(i, i + len))
      i += len
    } else if (wire === 5) i += 4
    else if (wire === 1) i += 8
    else return
  }
}

/** Media list of new exports: MediaEntries { repeated MediaEntry entries = 1 }, MediaEntry { string name = 1 }. */
function mediaEntries(buf: Uint8Array): string[] {
  const names: string[] = []
  readProto(buf, (f, entry) => {
    if (f !== 1 || !(entry instanceof Uint8Array)) return
    let name = ''
    readProto(entry, (f2, v) => {
      if (f2 === 1 && v instanceof Uint8Array) name = new TextDecoder().decode(v)
    })
    names.push(name)
  })
  return names
}

function readMedia(files: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const index = files['media']
  if (!index) return out
  let names: Record<string, string>
  const raw = unz(index)
  try {
    names = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    names = Object.fromEntries(mediaEntries(raw).map((n, i) => [String(i), n]))
  }
  for (const [zipName, name] of Object.entries(names)) {
    const data = files[zipName]
    if (data && name) out.set(name, unz(data))
  }
  return out
}

function rows<T>(db: Database, sql: string): T[] {
  const res = db.exec(sql)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])) as T)
}

function deckNames(db: Database): Map<number, string> {
  const map = new Map<number, string>()
  try {
    // schema 18 (current Anki): a decks table, levels separated by \x1f
    for (const d of rows<{ id: number; name: string }>(db, 'SELECT id, name FROM decks'))
      map.set(Number(d.id), d.name.split('\x1f').join('::'))
    if (map.size) return map
  } catch {
    /* legacy schema */
  }
  const [col] = rows<{ decks: string }>(db, 'SELECT decks FROM col')
  for (const d of Object.values(JSON.parse(col?.decks || '{}')) as { id: number; name: string }[])
    map.set(Number(d.id), d.name)
  return map
}

/** Anki field HTML → text with "\n" line breaks, MathJax as $…$, and the images it shows. */
export function fieldToText(html: string): { text: string; images: string[] } {
  const images: string[] = []
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  let text = ''
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      text += n.textContent ?? ''
      return
    }
    if (!(n instanceof HTMLElement)) return
    const tag = n.tagName
    if (tag === 'BR') return void (text += '\n')
    if (tag === 'IMG') {
      const src = n.getAttribute('src')
      if (src) images.push(decodeURIComponent(src))
      return
    }
    if (tag === 'SCRIPT' || tag === 'STYLE') return
    const block = /^(DIV|P|LI|UL|OL|H[1-6]|TR|TABLE|BLOCKQUOTE|PRE)$/.test(tag)
    if (block && text && !text.endsWith('\n')) text += '\n'
    if (tag === 'LI') text += '• '
    n.childNodes.forEach(walk)
    if (block && !text.endsWith('\n')) text += '\n'
  }
  doc.body.childNodes.forEach(walk)
  text = text
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/ /g, ' ')
    // MathJax → $…$ (marked with control chars so literal dollars stay text)
    .replace(/\\\((.+?)\\\)/gs, (_, m) => `\u0001${m.trim()}\u0002`)
    .replace(/\\\[(.+?)\\\]/gs, (_, m) => `\u0001${m.trim()}\u0002`)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, images }
}

/** {{c1::Antwort::Hinweis}} → {{Antwort}} (Synapse reveals every gap of a cloze note on one card). */
export const clozeToSynapse = (text: string) => text.replace(/\{\{c\d+::(.*?)(?:::[^{}]*?)?\}\}/gs, '{{$1}}')

export async function readAnkiPackage(file: File): Promise<AnkiPackage> {
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const colName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => files[n])
  if (!colName) throw new Error('Keine Anki-Sammlung in der Datei gefunden (.apkg oder .colpkg erwartet).')
  const SQL = await initSqlJs({ locateFile: () => wasmUrl })
  const db = new SQL.Database(unz(files[colName]))
  try {
    const decks = deckNames(db)
    const notes = rows<{ id: number; flds: string; did: number; ncards: number }>(
      db,
      `SELECT n.id, n.flds,
              (SELECT did FROM cards c WHERE c.nid = n.id ORDER BY c.ord LIMIT 1) AS did,
              (SELECT COUNT(*) FROM cards c WHERE c.nid = n.id) AS ncards
       FROM notes n ORDER BY n.id`,
    )
    const byDeck = new Map<string, AnkiCard[]>()
    for (const n of notes) {
      const fields = n.flds.split('\x1f').map(fieldToText)
      const first = fields[0]?.text ?? ''
      if (!first) continue
      const images = fields.flatMap((f) => f.images)
      const isCloze = /\{\{c\d+::/.test(first)
      const card: AnkiCard = isCloze
        ? { kind: 'cloze', front: clozeToSynapse(first), back: fields[1]?.text ?? '', images }
        : { kind: Number(n.ncards) === 2 ? 'reverse' : 'basic', front: first, back: fields[1]?.text ?? '', images }
      const deck = decks.get(Number(n.did)) ?? 'Default'
      if (!byDeck.has(deck)) byDeck.set(deck, [])
      byDeck.get(deck)!.push(card)
    }
    return {
      decks: [...byDeck].map(([name, cards]) => ({ path: name.split('::').map((s) => s.trim()).filter(Boolean), cards })),
      media: readMedia(files),
    }
  } finally {
    db.close()
  }
}

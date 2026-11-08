import { useState } from 'react'
import { api } from '../api'
import { uploadImage } from '../editor/upload'
import { Icon } from '../components/Icons'
import type { AnkiCard, AnkiPackage } from './anki'
import { t } from '../i18n'

/** Fills {placeholders} in a translated sentence with React nodes. */
function fill(text: string, parts: Record<string, React.ReactNode>): React.ReactNode[] {
  return text.split(/\{(\w+)\}/).map((s, i) => (i % 2 ? <span key={i}>{parts[s]}</span> : s))
}

/** Cards per Synapse note, so huge decks stay pleasant to open. */
const PER_NOTE = 150
const ROOT = 'Anki'

type Json = Record<string, unknown>

/** Text with "\n" and \uE000latex\uE001 markers → TipTap inline nodes. */
function inline(text: string): Json[] {
  const out: Json[] = []
  text.split('\n').forEach((line, i) => {
    if (i) out.push({ type: 'hardBreak' })
    line.split(/\uE000([^\uE001]*)\uE001/).forEach((part, j) => {
      if (j % 2) out.push({ type: 'inlineMath', attrs: { latex: part } })
      else if (part) out.push({ type: 'text', text: part })
    })
  })
  return out
}

function cardBlocks(card: AnkiCard, images: Map<string, string>): Json[] {
  const content =
    card.kind === 'cloze' || !card.back
      ? inline(card.front)
      : [...inline(card.front), { type: 'text', text: card.kind === 'reverse' ? ' :: ' : ' >> ' }, ...inline(card.back)]
  const blocks: Json[] = [{ type: 'paragraph', content }]
  for (const name of card.images) {
    const src = images.get(name)
    if (src) blocks.push({ type: 'image', attrs: { src, alt: name } })
  }
  return blocks
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

interface Props {
  onClose: () => void
  onDone: (folder: string) => void
}

type Phase =
  | { step: 'pick' }
  | { step: 'work'; label: string; done: number; total: number }
  | { step: 'done'; decks: number; notes: number; cards: number; images: number }
  | { step: 'error'; message: string }

export default function AnkiImport({ onClose, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'pick' })
  const [over, setOver] = useState(false)

  const run = async (file: File) => {
    try {
      setPhase({ step: 'work', label: t('Lese Anki-Datei…'), done: 0, total: 1 })
      const { readAnkiPackage } = await import('./anki') // sql.js + zstd only load when needed
      const pkg: AnkiPackage = await readAnkiPackage(file)
      const total = pkg.decks.reduce((n, d) => n + d.cards.length, 0)
      if (!total) throw new Error(t('Die Datei enthält keine Karten.'))

      // upload the images the cards show
      const wanted = new Set(pkg.decks.flatMap((d) => d.cards.flatMap((c) => c.images)))
      const images = new Map<string, string>()
      let i = 0
      for (const name of wanted) {
        setPhase({ step: 'work', label: t('Lade Bilder hoch…'), done: i++, total: wanted.size })
        const data = pkg.media.get(name)
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        if (!data || !MIME[ext]) continue
        const copy = new Uint8Array(data) // detach from the zip buffer
        images.set(name, await uploadImage(new File([copy], name, { type: MIME[ext] })))
      }

      let done = 0
      let notes = 0
      for (const deck of pkg.decks) {
        const path = deck.path.length ? deck.path : ['Default']
        const folder = [ROOT, ...path.slice(0, -1)].join('/')
        const leaf = path[path.length - 1]
        for (let start = 0; start < deck.cards.length; start += PER_NOTE) {
          const chunk = deck.cards.slice(start, start + PER_NOTE)
          const title = start ? `${leaf} (${start / PER_NOTE + 1})` : leaf
          const doc = { type: 'doc', content: chunk.flatMap((c) => cardBlocks(c, images)) }
          await api.createNote(title, JSON.stringify(doc), { folder })
          notes++
          done += chunk.length
          setPhase({ step: 'work', label: t('Lege Karten an: {path}', { path: path.join(' › ') }), done, total })
        }
      }
      setPhase({ step: 'done', decks: pkg.decks.length, notes, cards: total, images: images.size })
    } catch (e) {
      setPhase({ step: 'error', message: (e as Error).message })
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && phase.step !== 'work' && onClose()}>
      <div className="modal import-modal">
        <header>
          <h2>{t('Aus Anki importieren')}</h2>
          {phase.step !== 'work' && (
            <button className="icon-btn" onClick={onClose} title={t('Schließen')}><Icon name="x" /></button>
          )}
        </header>

        {phase.step === 'pick' && (
          <>
            <label
              className={`dropzone ${over ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                const f = e.dataTransfer.files[0]
                if (f) run(f)
              }}
            >
              <Icon name="import" />
              <b>{t('.apkg oder .colpkg hierher ziehen')}</b>
              <span>{t('oder klicken, um eine Datei zu wählen')}</span>
              <input type="file" accept=".apkg,.colpkg" onChange={(e) => e.target.files?.[0] && run(e.target.files[0])} hidden />
            </label>
            <ul className="import-notes">
              <li>{fill(t('Jeder Stapel wird zu einer Notiz im Ordner {folder}, Unterstapel zu Unterseiten.'), { folder: <code>Anki/</code> })}</li>
              <li>
                {fill(t('Basis-Karten werden zu {basic}, „mit Rückrichtung" zu {reverse}, Lückentexte zu {cloze}.'), {
                  basic: <code>{t('Frage >> Antwort')}</code>,
                  reverse: <code>::</code>,
                  cloze: <code>{'{{…}}'}</code>,
                })}
              </li>
              <li>{t('Bilder und MathJax-Formeln werden übernommen, Audio nicht. Alle Karten starten als neu.')}</li>
              <li>{t('In Anki: Datei → Exportieren → „Anki Deck Package (.apkg)".')}</li>
            </ul>
          </>
        )}

        {phase.step === 'work' && (
          <div className="import-progress">
            <span>{phase.label}</span>
            <div className="study-bar"><div style={{ width: `${(phase.done / Math.max(1, phase.total)) * 100}%` }} /></div>
            <span className="muted">{phase.done} / {phase.total}</span>
          </div>
        )}

        {phase.step === 'done' && (
          <div className="import-result">
            <p>
              {fill(t('{cards} aus {decks} importiert – in {notes}{images}.'), {
                cards: <b>{phase.cards === 1 ? t('1 Karte') : t('{n} Karten', { n: phase.cards })}</b>,
                decks: phase.decks === 1 ? t('1 Stapel') : t('{n} Stapeln', { n: phase.decks }),
                notes: phase.notes === 1 ? t('1 Notiz') : t('{n} Notizen', { n: phase.notes }),
                images: !phase.images ? '' : phase.images === 1 ? t(', mit 1 Bild') : t(', mit {n} Bildern', { n: phase.images }),
              })}
            </p>
            <button className="btn primary" onClick={() => onDone(ROOT)}>{t('Ordner öffnen')}</button>
          </div>
        )}

        {phase.step === 'error' && (
          <div className="import-result">
            <p className="error-text">{phase.message}</p>
            <button className="btn" onClick={() => setPhase({ step: 'pick' })}>{t('Andere Datei wählen')}</button>
          </div>
        )}
      </div>
    </div>
  )
}

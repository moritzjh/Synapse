import { useCallback, useEffect, useState } from 'react'
import { cardApi, type Card, type ReviewStats } from '../api'

type Rating = 1 | 2 | 3 | 4

const RATINGS: { r: Rating; label: string; cls: string }[] = [
  { r: 1, label: 'Nochmal', cls: 'again' },
  { r: 2, label: 'Schwer', cls: 'hard' },
  { r: 3, label: 'Gut', cls: 'good' },
  { r: 4, label: 'Einfach', cls: 'easy' },
]

/** "[[Titel|Alias]]" → "Alias", "[[Titel]]" → "Titel" for display on cards. */
const clean = (s: string) => s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, a) => a ?? t)

export function formatInterval(ms: number) {
  const min = ms / 60_000
  if (min < 60) return `${Math.max(1, Math.round(min))} Min`
  const h = min / 60
  if (h < 24) return `${Math.round(h)} Std`
  const d = h / 24
  if (d < 30) return `${Math.round(d)} T`
  if (d < 365) return `${Math.round(d / 30)} Mon`
  return `${(d / 365).toFixed(1)} J`
}

/** How many parts of the answer exist and must be revealed before rating. */
function partCount(card: Card) {
  if (card.kind === 'list') return card.data.items?.length ?? 0
  if (card.kind === 'cloze') return card.data.segments?.filter((s) => 'cloze' in s).length ?? 0
  return 1
}

export default function Review({ onOpenNote, onChanged }: { onOpenNote: (id: number) => void; onChanged: () => void }) {
  const [queue, setQueue] = useState<Card[] | null>(null)
  const [stats, setStats] = useState<ReviewStats | null>(null)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    const [q, s] = await Promise.all([cardApi.queue(), cardApi.stats()])
    setQueue(q)
    setStats(s)
    setRevealed(new Set())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const card = queue?.[0]
  const parts = card ? partCount(card) : 0
  const allRevealed = card ? revealed.size >= parts : false

  const revealNext = useCallback(() => {
    if (!card) return
    for (let i = 0; i < parts; i++) {
      if (!revealed.has(i)) {
        setRevealed(new Set(revealed).add(i))
        return
      }
    }
  }, [card, parts, revealed])

  const revealAll = () => setRevealed(new Set(Array.from({ length: parts }, (_, i) => i)))
  const toggle = (i: number) => setRevealed((r) => new Set(r).add(i))

  const rate = useCallback(
    async (r: Rating) => {
      if (!card) return
      await cardApi.review(card.id, r)
      setRevealed(new Set())
      const rest = queue!.slice(1)
      if (rest.length) {
        setQueue(rest)
        cardApi.stats().then(setStats)
      } else {
        await load() // picks up learning cards that became due meanwhile
      }
      onChanged()
    },
    [card, queue, load, onChanged],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || (e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        revealNext()
      } else if (allRevealed && ['1', '2', '3', '4'].includes(e.key)) {
        rate(Number(e.key) as Rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, allRevealed, revealNext, rate])

  if (!queue || !stats) return <div className="empty">Lädt…</div>

  return (
    <div className="review">
      <div className="review-stats">
        <span><b className="c-due">{stats.due}</b> fällig</span>
        <span><b className="c-new">{stats.new}</b> neu</span>
        <span><b>{stats.reviewed_today}</b> heute gelernt</span>
        <span className="muted">{stats.total} Karten insgesamt</span>
      </div>

      {!card ? (
        <div className="empty">
          <p>🎉 Alles erledigt für jetzt.</p>
          <p className="muted">
            Karten entstehen automatisch aus deinen Notizen: <code>Frage &gt;&gt; Antwort</code>,{' '}
            <code>Begriff :: Definition</code>, <code>{'{{Lücke}}'}</code> oder <code>Frage &gt;&gt;</code> mit einer
            Liste darunter.
          </p>
          <button onClick={load}>Neu laden</button>
        </div>
      ) : (
        <div className="flashcard-wrap">
          <div className="flashcard">
            <button className="card-source" onClick={() => onOpenNote(card.note_id)}>
              {card.note_title} ↗
            </button>
            {card.state === 0 && <span className="badge new">Neu</span>}

            {card.kind === 'cloze' ? (
              <div className="card-front cloze-text">
                {(() => {
                  let gap = -1
                  return card.data.segments!.map((s, i) => {
                    if ('text' in s) return <span key={i}>{clean(s.text)}</span>
                    gap++
                    const g = gap
                    return revealed.has(g) ? (
                      <span key={i} className="cloze revealed">{clean(s.cloze)}</span>
                    ) : (
                      <button key={i} className="cloze hidden" onClick={() => toggle(g)} title="Aufdecken">
                        {' '.repeat(Math.min(Math.max(s.cloze.length, 4), 24))}
                      </button>
                    )
                  })
                })()}
              </div>
            ) : (
              <div className="card-front">{clean(card.front)}</div>
            )}

            {(card.kind === 'basic' || card.kind === 'reverse') && allRevealed && (
              <div className="card-back">{clean(card.data.back ?? '')}</div>
            )}

            {card.kind === 'list' && (
              <ol className="card-items">
                {card.data.items!.map((item, i) =>
                  revealed.has(i) ? (
                    <li key={i} className="revealed">{clean(item)}</li>
                  ) : (
                    <li key={i}>
                      <button className="cover" onClick={() => toggle(i)}>Aufdecken</button>
                    </li>
                  ),
                )}
              </ol>
            )}
          </div>

          <div className="review-actions">
            {!allRevealed ? (
              <>
                <button className="primary" onClick={revealNext}>
                  {parts > 1 ? `Nächsten Punkt aufdecken (${revealed.size}/${parts})` : 'Antwort zeigen'}
                  <kbd>Leertaste</kbd>
                </button>
                {parts > 1 && <button onClick={revealAll}>Alle aufdecken</button>}
              </>
            ) : (
              RATINGS.map(({ r, label, cls }) => (
                <button key={r} className={`rate ${cls}`} onClick={() => rate(r)}>
                  <span>{label}</span>
                  <small>{card.intervals ? formatInterval(card.intervals[String(r) as '1']) : ''}</small>
                  <kbd>{r}</kbd>
                </button>
              ))
            )}
          </div>
          <p className="muted queue-left">{queue.length - 1} weitere in dieser Runde</p>
        </div>
      )}
    </div>
  )
}

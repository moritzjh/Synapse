import { useCallback, useEffect, useState } from 'react'
import { cardApi, type Card, type Exam, type ReviewStats } from '../api'
import { Icon } from './Icons'

type Rating = 1 | 2 | 3 | 4

const RATINGS: { r: Rating; label: string; cls: string }[] = [
  { r: 1, label: 'Nochmal', cls: 'again' },
  { r: 2, label: 'Schwer', cls: 'hard' },
  { r: 3, label: 'Gut', cls: 'good' },
  { r: 4, label: 'Einfach', cls: 'easy' },
]

/** "[[Titel|Alias]]" → "Alias", "[[Titel]]" → "Titel" for display on cards. */
const clean = (s: string) => s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, a) => a ?? t)

const maskStyle = (m: { x: number; y: number; w: number; h: number }) => ({
  left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`,
})

function formatInterval(ms: number) {
  const min = ms / 60_000
  if (min < 60) return `${Math.max(1, Math.round(min))} Min`
  const h = min / 60
  if (h < 24) return `${Math.round(h)} Std`
  const d = h / 24
  if (d < 30) return `${Math.round(d)} ${Math.round(d) === 1 ? 'Tag' : 'Tage'}`
  if (d < 365) return `${Math.round(d / 30)} Mon`
  return `${(d / 365).toFixed(1)} J`
}

/** Parts of the answer that must be revealed before rating. */
function partCount(card: Card) {
  if (card.kind === 'list') return card.data.items?.length ?? 0
  if (card.kind === 'cloze') return card.data.segments?.filter((s) => 'cloze' in s).length ?? 0
  if (card.kind === 'occlusion') return card.data.masks?.length ?? 0
  return 1
}

/** Masks are revealed top-to-bottom, left-to-right (reading order). */
const maskOrder = (card: Card) =>
  [...(card.data.masks ?? [])].sort((a, b) => (Math.abs(a.y - b.y) > 0.04 ? a.y - b.y : a.x - b.x))

const KIND_NAME: Record<Card['kind'], string> = {
  basic: 'Frage',
  reverse: 'Umgekehrt',
  list: 'Liste',
  cloze: 'Lückentext',
  occlusion: 'Bild',
}

interface Props {
  exam?: number
  exams: Exam[]
  onExam: (exam?: number) => void
  onOpenNote: (id: number) => void
  onChanged: () => void
}

export default function Review({ exam, exams, onExam, onOpenNote, onChanged }: Props) {
  const [queue, setQueue] = useState<Card[] | null>(null)
  const [stats, setStats] = useState<ReviewStats | null>(null)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [done, setDone] = useState(0)
  const [ratings, setRatings] = useState<number[]>([])

  const load = useCallback(async () => {
    const [q, s] = await Promise.all([cardApi.queue(exam), cardApi.stats(exam)])
    setQueue(q)
    setStats(s)
    setRevealed(new Set())
  }, [exam])

  useEffect(() => {
    load()
  }, [load])

  // Space reveals – make sure it doesn't also "click" a focused sidebar button.
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }, [])

  const card = queue?.[0]
  const parts = card ? partCount(card) : 0
  const allRevealed = card ? revealed.size >= parts : false

  const revealNext = useCallback(() => {
    for (let i = 0; i < parts; i++)
      if (!revealed.has(i)) return setRevealed(new Set(revealed).add(i))
  }, [parts, revealed])
  const reveal = (i: number) => setRevealed((r) => new Set(r).add(i))

  const rate = useCallback(
    async (r: Rating) => {
      if (!card) return
      await cardApi.review(card.id, r)
      setDone((d) => d + 1)
      setRatings((x) => [...x, r])
      setRevealed(new Set())
      const rest = queue!.slice(1)
      if (rest.length) {
        setQueue(rest)
        cardApi.stats(exam).then(setStats)
      } else {
        await load()
      }
      onChanged()
    },
    [card, queue, load, onChanged, exam],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!allRevealed) revealNext()
      } else if (allRevealed && ['1', '2', '3', '4'].includes(e.key)) {
        rate(Number(e.key) as Rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, allRevealed, revealNext, rate])

  if (!queue || !stats) return <div className="scroll" />
  const current = exams.find((e) => e.id === exam)

  return (
    <div className="scroll">
      <div className="review">
        <div className="review-top">
          <select value={exam ?? 0} onChange={(e) => onExam(Number(e.target.value) || undefined)}>
            <option value={0}>Alle Karten</option>
            {exams.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <div className="counts">
            <span className="due"><b>{stats.due}</b> fällig</span>
            <span className="new"><b>{stats.new}</b> neu</span>
            <span><b>{stats.reviewed_today}</b> heute</span>
          </div>
        </div>
        <div className="progress"><div style={{ width: `${(done / Math.max(1, done + queue.length)) * 100}%` }} /></div>

        {!card ? (
          <div className="review-done">
            {done > 0 ? (
              <>
                <div className="done-number">{done}</div>
                <p>{done === 1 ? 'Karte' : 'Karten'} gelernt{current ? ` für ${current.name}` : ''}</p>
                <div className="done-bars">
                  {RATINGS.map(({ r, label, cls }) => {
                    const n = ratings.filter((x) => x === r).length
                    return (
                      <div key={r} className={`done-bar ${cls}`}>
                        <span style={{ height: `${(n / Math.max(1, done)) * 100}%` }} />
                        <small>{label}</small>
                        <b>{n}</b>
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <p>Für jetzt ist alles gelernt{current ? ` für ${current.name}` : ''}.</p>
            )}
            <p className="muted small">
              Karten entstehen aus deinen Notizen: <code>Frage &gt;&gt; Antwort</code> · <code>Begriff :: Definition</code> ·{' '}
              <code>{'{{Lücke}}'}</code> · Liste unter <code>Frage &gt;&gt;</code> · abgedeckte Bilder
            </p>
          </div>
        ) : (
          <>
            <article className={`flashcard kind-${card.kind} ${allRevealed ? 'revealed' : ''}`} key={card.id}>
              <header className="fc-head">
                <button className="card-source" onClick={() => onOpenNote(card.note_id)}>
                  <Icon name="note" /> {card.note_title}
                </button>
                <span className="fc-kind">{KIND_NAME[card.kind]}</span>
                {card.state === 0 && <span className="fc-new">neu</span>}
              </header>

              {card.kind === 'occlusion' ? (
                <div className="fc-image">
                  <img src={card.data.src} alt={card.front} />
                  {maskOrder(card).map((m, i) =>
                    revealed.has(i) ? (
                      <div key={m.id} className="fc-mask open" style={maskStyle(m)}>
                        {m.label && <span>{m.label}</span>}
                      </div>
                    ) : (
                      <button key={m.id} className={`fc-mask ${i === revealed.size ? 'next' : ''}`} style={maskStyle(m)} onClick={() => reveal(i)}>
                        {i + 1}
                      </button>
                    ),
                  )}
                </div>
              ) : card.kind === 'cloze' ? (
                <div className="card-front cloze-text">
                  {(() => {
                    let gap = -1
                    return card.data.segments!.map((s, i) => {
                      if ('text' in s) return <span key={i}>{clean(s.text)}</span>
                      const g = ++gap
                      return revealed.has(g) ? (
                        <span key={i} className="cloze revealed">{clean(s.cloze)}</span>
                      ) : (
                        <button key={i} className={`cloze hidden ${g === revealed.size ? 'next' : ''}`} onClick={() => reveal(g)} title="Aufdecken">
                          {'\u00a0'.repeat(Math.min(Math.max(s.cloze.length, 4), 24))}
                        </button>
                      )
                    })
                  })()}
                </div>
              ) : (
                <div className="card-front">{clean(card.front)}</div>
              )}

              {(card.kind === 'basic' || card.kind === 'reverse') && (
                <div className={`card-back ${allRevealed ? 'shown' : ''}`}>{allRevealed ? clean(card.data.back ?? '') : ''}</div>
              )}

              {card.kind === 'list' && (
                <ol className="card-items">
                  {card.data.items!.map((item, i) =>
                    revealed.has(i) ? (
                      <li key={i} className="revealed">{clean(item)}</li>
                    ) : (
                      <li key={i}>
                        <button className={`cover ${i === revealed.size ? 'next' : ''}`} onClick={() => reveal(i)} />
                      </li>
                    ),
                  )}
                </ol>
              )}
            </article>

            <div className="review-actions">
              {!allRevealed ? (
                <>
                  <button className="btn primary big" onClick={revealNext}>
                    {parts > 1 ? `Aufdecken ${revealed.size + 1}/${parts}` : 'Antwort zeigen'}
                    <kbd>Leertaste</kbd>
                  </button>
                  {parts > 1 && (
                    <button className="btn ghost" onClick={() => setRevealed(new Set(Array.from({ length: parts }, (_, i) => i)))}>
                      Alle aufdecken
                    </button>
                  )}
                </>
              ) : (
                <div className="rates">
                  {RATINGS.map(({ r, label, cls }) => (
                    <button key={r} className={`rate ${cls}`} onClick={() => rate(r)}>
                      <span>{label}</span>
                      <small>{card.intervals ? formatInterval(card.intervals[String(r) as '1']) : ''}</small>
                      <kbd>{r}</kbd>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

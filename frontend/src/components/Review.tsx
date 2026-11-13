import { useCallback, useEffect, useRef, useState } from 'react'
import { cardApi, type Card, type Exam, type Mask, type ReviewStats } from '../api'
import { Icon } from './Icons'
import MathText from './MathText'
import { locale, t } from '../i18n'

type Rating = 1 | 2 | 3 | 4

const RATINGS: { r: Rating; label: string; cls: string }[] = [
  { r: 1, label: t('Nochmal'), cls: 'again' },
  { r: 2, label: t('Schwer'), cls: 'hard' },
  { r: 3, label: t('Gut'), cls: 'good' },
  { r: 4, label: t('Einfach'), cls: 'easy' },
]

const KIND: Record<Card['kind'], { name: string; icon: 'text' | 'reset' | 'multi' | 'title' | 'image' }> = {
  basic: { name: t('Frage'), icon: 'text' },
  reverse: { name: t('Umgekehrt'), icon: 'reset' },
  list: { name: t('Liste'), icon: 'multi' },
  cloze: { name: t('Lückentext'), icon: 'title' },
  occlusion: { name: t('Bild'), icon: 'image' },
}

/** "[[Titel|Alias]]" → "Alias", "[[Titel]]" → "Titel" for display on cards. */
const clean = (s: string) => s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, a) => a ?? t)
const long = (s: string) => (s.length > 160 || s.split('\n').length > 4 ? ' long' : '')

function formatInterval(ms: number) {
  const min = ms / 60_000
  if (min < 60) return t('{n} Min', { n: Math.max(1, Math.round(min)) })
  const h = min / 60
  if (h < 24) return t('{n} Std', { n: Math.round(h) })
  const d = h / 24
  if (d < 30) return Math.round(d) === 1 ? t('1 Tag') : t('{n} Tage', { n: Math.round(d) })
  if (d < 365) return t('{n} Mon', { n: Math.round(d / 30) })
  return t('{n} J', { n: (d / 365).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

/** Parts of the answer that must be revealed before rating. */
function partCount(card: Card) {
  if (card.kind === 'list') return card.data.items?.length ?? 0
  if (card.kind === 'cloze') return card.data.segments?.filter((s) => 'cloze' in s).length ?? 0
  if (card.kind === 'occlusion') return card.data.masks?.length ?? 0
  return 1
}

/** Masks are revealed in reading order: top-to-bottom, left-to-right. */
const maskOrder = (card: Card) =>
  [...(card.data.masks ?? [])].sort((a, b) => (Math.abs(a.y - b.y) > 0.04 ? a.y - b.y : a.x - b.x))

const maskStyle = (m: Mask) => ({ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` })

/** A folder ("Uni/Bio") or note file ("Uni/Bio/Zelle.md") to study on its own. */
export interface StudyScope {
  path: string
  name: string
}

interface Props {
  exam?: number
  scope?: StudyScope
  exams: Exam[]
  onExam: (exam?: number) => void
  onOpenNote: (id: number) => void
  onChanged: () => void
}

export default function Review({ exam, scope, exams, onExam, onOpenNote, onChanged }: Props) {
  const path = scope?.path
  const [queue, setQueue] = useState<Card[] | null>(null)
  const [stats, setStats] = useState<ReviewStats | null>(null)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [ratings, setRatings] = useState<Rating[]>([])
  const [leaving, setLeaving] = useState<Rating | null>(null)
  const cardRef = useRef<HTMLElement>(null)

  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const [q, s] = await Promise.all([cardApi.queue(exam, path), cardApi.stats(exam, path)])
      setQueue(q)
      setStats(s)
      setRevealed(new Set())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [exam, path])

  useEffect(() => {
    load()
  }, [load])

  // Space reveals – make sure it doesn't also "click" a focused sidebar button.
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }, [])

  const card = queue?.[0]
  const parts = card ? partCount(card) : 0

  // Long cards scroll inside: keep the part that was just revealed (and the next one) in view.
  useEffect(() => {
    const el = cardRef.current?.querySelector('.fc-list li.next, .gap.next, .fc-list li.open:last-child')
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [revealed])
  const allRevealed = card ? revealed.size >= parts : false
  const done = ratings.length

  const revealNext = useCallback(() => {
    for (let i = 0; i < parts; i++) if (!revealed.has(i)) return setRevealed(new Set(revealed).add(i))
  }, [parts, revealed])
  const reveal = (i: number) => setRevealed((r) => new Set(r).add(i))

  const rate = useCallback(
    async (r: Rating) => {
      if (!card || leaving) return
      setLeaving(r)
      try {
        await Promise.all([cardApi.review(card.id, r), new Promise((ok) => setTimeout(ok, 260))])
      } catch {
        // not recorded: keep the card so it can be graded again
        setLeaving(null)
        setFailed(true)
        return
      }
      setFailed(false)
      setRatings((x) => [...x, r])
      setRevealed(new Set())
      setLeaving(null)
      const rest = queue!.slice(1)
      if (rest.length) {
        setQueue(rest)
        cardApi.stats(exam, path).then(setStats).catch(() => {})
      } else {
        await load()
      }
      onChanged()
    },
    [card, queue, load, onChanged, exam, path, leaving],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      // Only plain key presses on the page itself: a focused button, link or dialog keeps its own Enter/Space.
      if (!card || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (target.closest('input, select, textarea, button, a, [role="dialog"], .modal') || document.querySelector('.modal-backdrop')) return
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!allRevealed) revealNext()
        else if (e.key === 'Enter') rate(3)
      } else if (allRevealed && ['1', '2', '3', '4'].includes(e.key)) {
        rate(Number(e.key) as Rating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, allRevealed, revealNext, rate])

  if (!queue || !stats)
    return (
      <div className="scroll">
        {failed && (
          <div className="empty-state">
            <p>{t('Die Karten konnten nicht geladen werden.')}</p>
            <button className="btn" onClick={load}>{t('Erneut versuchen')}</button>
          </div>
        )}
      </div>
    )
  const current = exams.find((e) => e.id === exam)
  const total = done + queue.length

  return (
    <div className="scroll study">
      <div className="study-top">
        <label className="study-deck">
          <Icon name="cards" />
          <select value={scope ? -1 : exam ?? 0} onChange={(e) => onExam(Number(e.target.value) || undefined)}>
            {scope && <option value={-1}>{scope.name}</option>}
            <option value={0}>{t('Alle Karten')}</option>
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <div className="study-progress">
          <div className="study-bar"><div style={{ width: `${(done / Math.max(1, total)) * 100}%` }} /></div>
          <span>{card ? `${done + 1} / ${total}` : `${done} / ${done}`}</span>
        </div>
        <div className="study-counts">
          <span title={t('neue Karten heute')}><i className="dot-new" />{stats.new}</span>
          <span title={t('fällige Wiederholungen')}><i className="dot-due" />{stats.due}</span>
        </div>
      </div>

      {!card ? (
        <Summary ratings={ratings} examName={scope?.name ?? current?.name} onAgain={load} />
      ) : (
        <div className="stage">
          <div className={`deck ${queue.length > 1 ? 'stacked' : ''}`}>
            <article
              ref={cardRef}
              key={card.id}
              className={`fc kind-${card.kind} ${allRevealed ? 'is-revealed' : ''} ${leaving ? `leave-${leaving === 1 ? 'left' : 'right'}` : ''}`}
            >
              <header className="fc-meta">
                <span className="fc-type"><Icon name={KIND[card.kind].icon} /> {KIND[card.kind].name}</span>
                <button className="fc-note" onClick={() => onOpenNote(card.note_id)} title={t('Notiz öffnen')}>
                  {card.note_title.trim() || t('Ohne Titel')}
                </button>
                <span className={`fc-state ${card.state === 0 ? 'new' : ''}`}>{card.state === 0 ? t('Neu') : card.lapses ? t('{n}× vergessen', { n: card.lapses }) : t('Wiederholung')}</span>
              </header>

              <CardBody card={card} revealed={revealed} allRevealed={allRevealed} reveal={reveal} />
            </article>
          </div>

          <div className="study-actions">
            {failed && <p className="error-text study-error">{t('Bewertung nicht gespeichert – bitte noch einmal.')}</p>}
            {!allRevealed ? (
              <div className="reveal-row">
                <button className="reveal-btn" onClick={revealNext}>
                  {parts > 1 ? <>{t('Aufdecken')} <span className="reveal-count">{revealed.size + 1}/{parts}</span></> : t('Antwort zeigen')}
                  <kbd>{t('Leertaste')}</kbd>
                </button>
                {parts > 1 && (
                  <button className="link-btn" onClick={() => setRevealed(new Set(Array.from({ length: parts }, (_, i) => i)))}>
                    {t('alle')}
                  </button>
                )}
              </div>
            ) : (
              <div className="grade">
                {RATINGS.map(({ r, label, cls }) => (
                  <button key={r} className={`grade-btn ${cls}`} onClick={() => rate(r)}>
                    <span className="grade-label"><i />{label}</span>
                    <span className="grade-ivl">{card.intervals ? formatInterval(card.intervals[String(r) as '1']) : ''}</span>
                    <kbd>{r}</kbd>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CardBody({ card, revealed, allRevealed, reveal }: { card: Card; revealed: Set<number>; allRevealed: boolean; reveal: (i: number) => void }) {
  if (card.kind === 'basic' || card.kind === 'reverse') {
    return (
      <div className="flip">
        <div className="flip-inner">
          <div className="face front">
            <div className={'fc-q' + long(card.front)}><MathText text={clean(card.front)} /></div>
          </div>
          <div className="face back" aria-hidden={!allRevealed}>
            <div className={'fc-q small' + long(card.front)}><MathText text={clean(card.front)} /></div>
            <div className="fc-rule" />
            <div className={'fc-a' + long(card.data.back ?? '')}><MathText text={clean(card.data.back ?? '')} /></div>
          </div>
        </div>
      </div>
    )
  }

  if (card.kind === 'cloze') {
    let gap = -1
    return (
      <div className="fc-body">
        <div className="fc-cloze">
          {card.data.segments!.map((s, i) => {
            if ('text' in s) return <span key={i}><MathText text={clean(s.text)} /></span>
            const g = ++gap
            return revealed.has(g) ? (
              <span key={i} className="gap open"><MathText text={clean(s.cloze)} /></span>
            ) : (
              <button key={i} className={`gap ${g === revealed.size ? 'next' : ''}`} onClick={() => reveal(g)} title={t('Aufdecken')}>
                <span><MathText text={clean(s.cloze)} /></span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (card.kind === 'list') {
    return (
      <div className="fc-body">
        <div className="fc-q"><MathText text={clean(card.front)} /></div>
        <ol className="fc-list">
          {card.data.items!.map((item, i) => (
            <li key={i} className={revealed.has(i) ? 'open' : i === revealed.size ? 'next' : ''}>
              <span className="fc-num">{i + 1}</span>
              {revealed.has(i) ? (
                <span className="fc-item"><MathText text={clean(item)} /></span>
              ) : (
                <button className="fc-cover" onClick={() => reveal(i)} aria-label={t('Punkt {n} aufdecken', { n: i + 1 })} />
              )}
            </li>
          ))}
        </ol>
      </div>
    )
  }

  // occlusion
  return (
    <div className="fc-body">
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
    </div>
  )
}

function Summary({ ratings, examName, onAgain }: { ratings: Rating[]; examName?: string; onAgain: () => void }) {
  const n = ratings.length
  if (!n) {
    return (
      <div className="study-empty">
        <div className="study-empty-mark"><Icon name="cards" /></div>
        <h2>{examName ? t('Alles gelernt für {name}', { name: examName }) : t('Alles gelernt')}</h2>
        <p>
          {t('Neue Karten entstehen direkt beim Schreiben:')} <code>{t('Frage >> Antwort')}</code>, <code>{t('Begriff :: Definition')}</code>,{' '}
          <code>{'{{' + t('Lückenwort') + '}}'}</code>, {t('eine Liste unter')} <code>{t('Frage >>')}</code> {t('oder ein abgedecktes Bild.')}
        </p>
      </div>
    )
  }
  const counts = RATINGS.map(({ r }) => ratings.filter((x) => x === r).length)
  const known = Math.round(((counts[2] + counts[3]) / n) * 100)
  const R = 54, C = 2 * Math.PI * R
  let offset = 0
  return (
    <div className="study-summary">
      <svg viewBox="0 0 140 140" width="160" height="160" className="summary-ring" role="img" aria-label={t('{n}% gewusst', { n: known })}>
        <circle cx="70" cy="70" r={R} className="ring-track" />
        {RATINGS.map(({ cls }, i) => {
          const len = (counts[i] / n) * C
          const el = (
            <circle
              key={cls}
              cx="70"
              cy="70"
              r={R}
              className={`ring-seg ${cls}`}
              strokeDasharray={`${Math.max(0, len - 3)} ${C}`}
              strokeDashoffset={-offset}
            />
          )
          offset += len
          return counts[i] ? el : null
        })}
        <text x="70" y="68" textAnchor="middle" className="ring-big">{known}%</text>
        <text x="70" y="88" textAnchor="middle" className="ring-small">{t('gewusst')}</text>
      </svg>
      <h2>{n === 1 ? t('1 Karte gelernt') : t('{n} Karten gelernt', { n })}{examName ? ` · ${examName}` : ''}</h2>
      <div className="summary-legend">
        {RATINGS.map(({ label, cls }, i) => (
          <span key={cls} className={cls}><i />{label} <b>{counts[i]}</b></span>
        ))}
      </div>
      <button className="reveal-btn" onClick={onAgain}>{t('Nach neuen Karten suchen')}</button>
    </div>
  )
}

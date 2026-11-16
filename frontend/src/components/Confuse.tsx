import { useCallback, useEffect, useState } from 'react'
import { cardApi, type Card, type ConfusablePair } from '../api'
import { t } from '../i18n'
import { Icon } from './Icons'
import MathText from './MathText'
import type { StudyScope } from './Review'

interface Props {
  exam?: number
  scope?: StudyScope
  onBack: () => void
  onOpenNote: (id: number) => void
  onChanged: () => void
}

/** "[[Titel|Alias]]" → "Alias" for display on cards. */
const clean = (s: string) => s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, a, b) => b ?? a)

function Answer({ card }: { card: Card }) {
  if (card.kind === 'list')
    return (
      <ul>
        {card.data.items!.map((i, k) => <li key={k}><MathText text={clean(i)} /></li>)}
      </ul>
    )
  if (card.kind === 'cloze')
    return (
      <p>
        {card.data.segments!.map((s, k) => ('text' in s ? <span key={k}><MathText text={clean(s.text)} /></span> : <mark key={k}><MathText text={clean(s.cloze)} /></mark>))}
      </p>
    )
  return <p><MathText text={clean(card.data.back ?? '')} /></p>
}

/**
 * Discrimination training: two cards that are similar in meaning but have different answers are shown
 * side by side. Telling them apart is what stops you mixing them up in an exam.
 */
export default function Confuse({ exam, scope, onBack, onOpenNote, onChanged }: Props) {
  const [pairs, setPairs] = useState<ConfusablePair[] | null>(null)
  const [info, setInfo] = useState({ enabled: true, pending: 0 })
  const [failed, setFailed] = useState(false)
  const [index, setIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [mixed, setMixed] = useState<ConfusablePair[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await cardApi.confusables(exam, scope?.path)
      setPairs(r.pairs)
      setInfo({ enabled: r.enabled, pending: r.pending })
      setIndex(0)
      setRevealed(false)
      setMixed([])
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [exam, scope?.path])

  useEffect(() => {
    load()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }, [load])

  const pair = pairs?.[index]

  const answer = useCallback(
    async (confused: boolean) => {
      if (!pair || busy) return
      if (confused) {
        setBusy(true)
        try {
          // a mix-up is a lapse for both cards: they come back soon in normal study
          await Promise.all([cardApi.review(pair.a.id, 1), cardApi.review(pair.b.id, 1)])
          setMixed((m) => [...m, pair])
          onChanged()
        } catch {
          setFailed(true)
          return
        } finally {
          setBusy(false)
        }
      }
      setFailed(false)
      setRevealed(false)
      setIndex((i) => i + 1)
    },
    [pair, busy, onChanged],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (!pair || e.repeat || e.ctrlKey || e.metaKey || e.altKey || target.closest('input, select, textarea, button, a')) return
      if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        setRevealed(true)
      } else if (revealed && e.key === '1') answer(true)
      else if (revealed && e.key === '2') answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pair, revealed, answer])

  const top = (
    <div className="study-top">
      <button className="study-deck cf-back" onClick={onBack}>‹ {t('Lernen')}</button>
      {pairs && pairs.length > 0 && (
        <div className="study-progress">
          <div className="study-bar"><div style={{ width: `${(Math.min(index, pairs.length) / pairs.length) * 100}%` }} /></div>
          <span>{Math.min(index + 1, pairs.length)} / {pairs.length}</span>
        </div>
      )}
    </div>
  )

  if (!pairs)
    return (
      <div className="scroll study">
        {top}
        {failed && (
          <div className="empty-state">
            <p>{t('Die Karten konnten nicht geladen werden.')}</p>
            <button className="btn" onClick={load}>{t('Erneut versuchen')}</button>
          </div>
        )}
      </div>
    )

  if (!pair) {
    const total = pairs.length
    return (
      <div className="scroll study">
        {top}
        <div className="study-empty">
          <div className="study-empty-mark"><Icon name="cards" /></div>
          {total === 0 ? (
            <>
              <h2>{t('Keine Verwechslungsgefahr gefunden')}</h2>
              <p>
                {!info.enabled
                  ? t('Dafür wird das Embedding-Modell gebraucht – es ist nicht geladen.')
                  : info.pending > 0
                    ? t('{n} Karten werden noch analysiert. Versuch es gleich noch einmal.', { n: info.pending })
                    : t('Hier erscheinen Karten, die sich inhaltlich ähneln, aber verschiedene Antworten haben – zum Beispiel Mitose und Meiose. Je mehr Karten du hast, desto mehr Paare findet Synapse.')}
              </p>
              {info.pending > 0 && <button className="reveal-btn" onClick={load}>{t('Erneut versuchen')}</button>}
            </>
          ) : (
            <>
              <h2>{t('{a} von {n} Paaren sicher unterschieden', { a: total - mixed.length, n: total })}</h2>
              {mixed.length > 0 ? (
                <>
                  <p>{t('Diese Karten hast du verwechselt. Sie kommen beim normalen Lernen bald wieder:')}</p>
                  <ul className="cf-mixed">
                    {mixed.map((m) => (
                      <li key={m.a.id}>
                        <MathText text={clean(m.a.front)} /> <span>↔</span> <MathText text={clean(m.b.front)} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>{t('Stark – du hältst alle ähnlichen Karten auseinander.')}</p>
              )}
              <button className="reveal-btn" onClick={onBack}>{t('Zurück zum Lernen')}</button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="scroll study">
      {top}
      <div className="stage cf-stage">
        <h2 className="cf-title">{t('Was ist der Unterschied?')}</h2>
        <div className="cf-pair">
          {[pair.a, pair.b].map((c) => (
            <article key={c.id} className="fc cf-card">
              <header className="fc-meta">
                <button className="fc-note cf-note" onClick={() => onOpenNote(c.note_id)} title={t('Notiz öffnen')}>
                  {c.note_title.trim() || t('Ohne Titel')}
                </button>
              </header>
              <div className="cf-q"><MathText text={clean(c.front)} /></div>
              <div className={`cf-a ${revealed ? 'open' : ''}`}>{revealed ? <Answer card={c} /> : <span aria-hidden>?</span>}</div>
            </article>
          ))}
        </div>
        <div className="study-actions">
          {failed && <p className="error-text study-error">{t('Bewertung nicht gespeichert – bitte noch einmal.')}</p>}
          {!revealed ? (
            <div className="reveal-row">
              <button className="reveal-btn" onClick={() => setRevealed(true)}>
                {t('Beide Antworten zeigen')} <kbd>{t('Leertaste')}</kbd>
              </button>
            </div>
          ) : (
            <div className="grade cf-grade">
              <button className="grade-btn again" onClick={() => answer(true)} disabled={busy}>
                <span className="grade-label"><i />{t('Verwechselt')}</span>
                <span className="grade-ivl">{t('beide kommen bald wieder')}</span>
                <kbd>1</kbd>
              </button>
              <button className="grade-btn good" onClick={() => answer(false)} disabled={busy}>
                <span className="grade-label"><i />{t('Klar unterschieden')}</span>
                <span className="grade-ivl">{t('Plan bleibt, wie er ist')}</span>
                <kbd>2</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

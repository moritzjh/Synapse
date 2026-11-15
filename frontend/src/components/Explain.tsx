import { useEffect, useRef, useState } from 'react'
import { explainApi, titleOf, type ExplainOutline, type ExplainResult, type NoteSummary } from '../api'
import { locale, t } from '../i18n'
import { Icon } from './Icons'
import MathText from './MathText'

interface Props {
  note: NoteSummary
  onOpenNote: (id: number) => void
  onStudy: (path: string, name: string) => void
}

type Status = ExplainResult['passages'][number]['status']
const LABEL: Record<Status, string> = { covered: t('Erklärt'), partial: t('Teilweise'), missing: t('Fehlt') }
const DOT: Record<Status, string> = { covered: 'status-strong', partial: 'status-fading', missing: 'status-weak' }
const pct = (v: number) => Math.round(v * 100)

/**
 * "Explain it" (Feynman technique): the note stays hidden while you write what you remember;
 * afterwards every passage of the note is marked as explained, partly explained or missing.
 */
export default function Explain({ note, onOpenNote, onStudy }: Props) {
  const [outline, setOutline] = useState<ExplainOutline | null>(null)
  const [text, setText] = useState('')
  const [hints, setHints] = useState(false)
  const [result, setResult] = useState<ExplainResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const title = titleOf(note.title)

  useEffect(() => {
    explainApi.outline(note.id).then(setOutline).catch(() => setError(t('Die Notiz konnte nicht geladen werden.')))
  }, [note.id])

  const compare = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      setResult(await explainApi.compare(note.id, text))
    } catch {
      setError(t('Der Vergleich ist fehlgeschlagen. Bitte versuche es noch einmal.'))
    } finally {
      setBusy(false)
    }
  }

  const again = () => {
    setResult(null)
    setTimeout(() => input.current?.focus())
  }

  const head = (
    <div className="note-top">
      <nav className="crumbs">
        <button onClick={() => onOpenNote(note.id)}>‹ {title}</button>
      </nav>
    </div>
  )

  if (result) {
    const count = (s: Status) => result.passages.filter((p) => p.status === s).length
    const total = result.passages.length
    const prev = result.previous
    const diff = prev ? pct(result.score) - pct(prev.score) : 0
    return (
      <div className="scroll">
        {head}
        <div className="page explain">
          <p className="explain-kicker">{t('Aus dem Kopf erklärt')}</p>
          <h1 className="page-title">{title}</h1>
          <div className="explain-score">
            <span className="explain-num">{pct(result.score)} %</span>
            <span>
              {t('{a} von {n} Abschnitten erklärt', { a: count('covered'), n: total })}
              {count('partial') > 0 && ` · ${t('{n} teilweise', { n: count('partial') })}`}
              {prev && diff !== 0 && (
                <em className={diff > 0 ? 'up' : 'down'}> · {diff > 0 ? t('{n} Punkte besser als beim letzten Mal', { n: diff }) : t('{n} Punkte unter dem letzten Mal', { n: -diff })}</em>
              )}
            </span>
          </div>
          <div className="explain-bar" role="img" aria-label={t('{a} von {n} Abschnitten erklärt', { a: count('covered'), n: total })}>
            {result.passages.map((p, i) => <i key={i} className={DOT[p.status]} />)}
          </div>
          {!result.semantic && <p className="explain-note">{t('Ohne Embedding-Modell wird nur nach Schlüsselbegriffen verglichen.')}</p>}

          <ol className="explain-list">
            {result.passages.map((p, i) => (
              <li key={i} className={`explain-item is-${p.status}`}>
                {p.heading && p.heading !== result.passages[i - 1]?.heading && <h3>{p.heading}</h3>}
                <div className="explain-row">
                  <span className="explain-status">
                    <i className={`status-dot ${DOT[p.status]}`} /> {LABEL[p.status]}
                  </span>
                  <div>
                    <p><MathText text={p.text} /></p>
                    {p.missing_terms.length > 0 && (
                      <p className="explain-missing">
                        {t('Nicht erwähnt:')} {p.missing_terms.map((m) => <span key={m}>{m}</span>)}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <div className="explain-actions">
            <button className="btn primary" onClick={again}>{t('Noch einmal erklären')}</button>
            <button className="btn" onClick={() => onOpenNote(note.id)}>{t('Notiz öffnen')}</button>
            <button className="btn ghost" onClick={() => onStudy(note.path, title)}>
              <Icon name="cards" /> {t('Karten lernen')}
            </button>
          </div>
          <details className="explain-own">
            <summary>{t('Dein Text')}</summary>
            <p>{text}</p>
          </details>
        </div>
      </div>
    )
  }

  return (
    <div className="scroll">
      {head}
      <div className="page explain">
        <p className="explain-kicker">{t('Erklär-Modus')}</p>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">
          {t('Schreibe auf, was du darüber weißt – so, als würdest du es jemandem erklären. Die Notiz bleibt verdeckt. Danach siehst du, welche Abschnitte du erklärt hast und welche fehlen.')}
        </p>
        {outline && outline.passages === 0 ? (
          <p className="explain-note">{t('Diese Notiz enthält noch keinen Text zum Erklären.')}</p>
        ) : (
          <>
            <textarea
              ref={input}
              className="explain-input"
              autoFocus
              value={text}
              placeholder={t('Fang einfach an …')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && compare()}
            />
            {hints && outline && outline.headings.length > 0 && (
              <p className="explain-hints">{t('Überschriften der Notiz:')} {outline.headings.join(' · ')}</p>
            )}
            <div className="explain-actions">
              <button className="btn primary" onClick={compare} disabled={!text.trim() || busy}>
                {busy ? t('Vergleiche …') : t('Mit der Notiz vergleichen')} <kbd>{t('Strg+Enter')}</kbd>
              </button>
              {outline && outline.headings.length > 0 && (
                <button className="btn ghost" onClick={() => setHints((h) => !h)}>{hints ? t('Überschriften verbergen') : t('Überschriften als Hilfe zeigen')}</button>
              )}
              <span className="explain-meta">
                {outline && (outline.passages === 1 ? t('1 Abschnitt') : t('{n} Abschnitte', { n: outline.passages }))}
                {outline?.previous && ` · ${t('letzter Versuch: {n} % am {date}', { n: pct(outline.previous.score), date: new Date(outline.previous.ts).toLocaleDateString(locale) })}`}
              </span>
            </div>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  )
}

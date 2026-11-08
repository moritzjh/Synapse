import { useState } from 'react'
import { examApi, titleOf, type Exam, type ExamInput, type NoteSummary } from '../api'
import { Icon } from './Icons'
import { locale, t } from '../i18n'

interface Props {
  exams: Exam[]
  notes: NoteSummary[]
  onChanged: () => void
  onStudy: (exam: number) => void
}

const DAY = 86_400_000
const isoDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Exams({ exams, notes, onChanged, onStudy }: Props) {
  const [editing, setEditing] = useState<Exam | 'new' | null>(null)

  const save = async (input: ExamInput) => {
    if (editing === 'new') await examApi.create(input)
    else if (editing) await examApi.update(editing.id, input)
    setEditing(null)
    onChanged()
  }

  return (
    <div className="scroll">
      <div className="page wide">
        <h1 className="page-title">{t('Prüfungen')}</h1>
        <p className="page-sub">
          {t(
            'Gib an, wann du welche Notizen können musst. Neue Karten werden so verteilt, dass du rechtzeitig fertig bist, und alles Wackelige kommt kurz vor dem Termin noch einmal dran.',
          )}
        </p>

        {editing ? (
          <ExamForm
            key={editing === 'new' ? 'new' : editing.id}
            exam={editing === 'new' ? null : editing}
            notes={notes}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button className="btn" style={{ marginBottom: 18 }} onClick={() => setEditing('new')}>
            <Icon name="plus" /> {t('Prüfung anlegen')}
          </button>
        )}

        <div className="exam-list">
          {exams.map((e) => {
            const p = e.progress
            const days = Math.ceil((e.date - Date.now()) / DAY)
            const learned = p.cards - p.new - p.mastered
            return (
              <div className="exam" key={e.id}>
                <h3>{e.name}</h3>
                <div className={`when ${days < 0 ? 'past' : ''}`}>
                  {new Date(e.date).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
                  {' · '}
                  <b>{days < 0 ? t('vorbei') : days === 0 ? t('heute') : days === 1 ? t('morgen') : t('in {n} Tagen', { n: days })}</b>
                </div>
                <div className="exam-actions">
                  <button className="btn primary" onClick={() => onStudy(e.id)} disabled={!p.cards}>{t('Lernen')}</button>
                  <button className="icon-btn" title={t('Bearbeiten')} onClick={() => setEditing(e)}><Icon name="edit" /></button>
                  <button
                    className="icon-btn"
                    title={t('Löschen')}
                    onClick={async () => {
                      if (!confirm(t('Prüfung „{name}“ löschen?', { name: e.name }))) return
                      await examApi.remove(e.id)
                      onChanged()
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
                <div className="bar" title={t('{mastered} sicher, {learned} angefangen, {new} neu', { mastered: p.mastered, learned, new: p.new })}>
                  <div className="m" style={{ width: `${(p.mastered / Math.max(1, p.cards)) * 100}%` }} />
                  <div className="l" style={{ width: `${(learned / Math.max(1, p.cards)) * 100}%` }} />
                </div>
                <div className="exam-stats">
                  <span><b>{Math.round(p.predicted_retention * 100)}%</b> {t('erwartete Erinnerung am Prüfungstag')}</span>
                  <span><b>{p.mastered}</b>/ {p.cards} {t('sicher')}</span>
                  {days >= 0 && <span><b>{p.new_today}</b> {t('neue heute')}</span>}
                  <span><b>{p.due}</b> {t('fällig')}</span>
                </div>
                <div className="exam-notes">{e.notes.map((n) => titleOf(n.title)).join(' · ') || t('Keine Notizen ausgewählt')}</div>
              </div>
            )
          })}
          {exams.length === 0 && !editing && <p className="muted">{t('Noch keine Prüfungen.')}</p>}
        </div>
      </div>
    </div>
  )
}

function ExamForm({ exam, notes, onSave, onCancel }: {
  exam: Exam | null
  notes: NoteSummary[]
  onSave: (e: ExamInput) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(exam?.name ?? '')
  const [date, setDate] = useState(exam ? isoDate(exam.date) : isoDate(Date.now() + 14 * DAY))
  const [picked, setPicked] = useState<Set<number>>(new Set(exam?.notes.map((n) => n.id) ?? []))
  const [filter, setFilter] = useState('')

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const visible = notes.filter((n) => n.title.toLowerCase().includes(filter.toLowerCase()))

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) onSave({ name: name.trim(), date, note_ids: [...picked] })
      }}
    >
      <div className="form-row">
        <label className="field">
          {t('Name')}
          <input type="text" value={name} autoFocus placeholder={t('z. B. Biologie-Klausur')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field" style={{ flex: '0 0 180px' }}>
          {t('Datum')}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="field">
        {t('Notizen ({n})', { n: picked.size })}
        <input type="search" placeholder={t('Filtern')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="pick-list">
          {visible.map((n) => (
            <label key={n.id}>
              <input type="checkbox" checked={picked.has(n.id)} onChange={() => toggle(n.id)} />
              {titleOf(n.title)}
            </label>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>{t('Abbrechen')}</button>
        <button type="submit" className="btn primary">{t('Speichern')}</button>
      </div>
    </form>
  )
}

import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { uid } from '../doc'
import { Icon } from '../../components/Icons'
import Chart from './Chart'
import { compile, FUNCTION_NAMES } from './formula'
import { displayValue, emptyDatabase, FILTER_OPS, newProperty, newView, numericValue, OP_LABEL, visibleRows } from './model'
import { COLORS, TYPE_ICON, TYPE_LABEL, type Cell, type Color, type DbAttrs, type Filter, type Option, type Property, type PropType, type Row, type View } from './types'

type Pop =
  | { kind: 'prop'; prop: string }
  | { kind: 'options'; row: string; prop: string }
  | { kind: 'filter' }
  | { kind: 'sort' }
  | { kind: 'addView' }
  | { kind: 'row'; row: string }
  | null

interface PopState {
  pop: Pop
  x: number
  y: number
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function DatabaseView({ node, updateAttributes, deleteNode, editor }: ReactNodeViewProps) {
  const db = node.attrs as DbAttrs
  const editable = editor.isEditable
  const [viewId, setViewId] = useState<string | undefined>(db.views[0]?.id)
  const [pop, setPop] = useState<PopState | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const view = db.views.find((v) => v.id === viewId) ?? db.views[0]
  const rows = useMemo(() => (view ? visibleRows(db, view) : db.rows), [db, view])

  const update = (fn: (d: DbAttrs) => void) => {
    const next = clone(db)
    fn(next)
    updateAttributes(next)
  }
  const updateView = (fn: (v: View) => void) =>
    update((d) => {
      const v = d.views.find((x) => x.id === view.id)
      if (v) fn(v)
    })
  const setCell = (rowId: string, propId: string, value: Cell) =>
    update((d) => {
      const r = d.rows.find((x) => x.id === rowId)
      if (r) r.cells[propId] = value
    })
  const addRow = (cells: Record<string, Cell> = {}) => {
    const id = uid()
    update((d) => void d.rows.push({ id, cells }))
    return id
  }

  const open = (p: Pop, e: React.MouseEvent) => {
    const box = root.current!.getBoundingClientRect()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPop({ pop: p, x: r.left - box.left, y: r.bottom - box.top + 4 })
  }

  useEffect(() => {
    if (!pop) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.db-pop')) setPop(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [pop])

  if (!view) return <NodeViewWrapper className="db" />

  const ctx: Ctx = { db, view, rows, editable, update, updateView, setCell, addRow, open, close: () => setPop(null) }

  return (
    <NodeViewWrapper className="db" contentEditable={false} ref={root}>
      <div className="db-head">
        <input
          className="db-title"
          value={db.title}
          placeholder="Ohne Titel"
          readOnly={!editable}
          onChange={(e) => update((d) => void (d.title = e.target.value))}
        />
        <div className="db-tools">
          {editable && (
            <>
              <button className={view.filters.length ? 'on' : ''} onClick={(e) => open({ kind: 'filter' }, e)}>
                Filter{view.filters.length ? ` · ${view.filters.length}` : ''}
              </button>
              <button className={view.sort ? 'on' : ''} onClick={(e) => open({ kind: 'sort' }, e)}>Sortieren</button>
              <button className="db-new" onClick={() => addRow()}>Neu</button>
            </>
          )}
        </div>
      </div>

      <div className="db-tabs">
        {db.views.map((v) => (
          <button
            key={v.id}
            className={v.id === view.id ? 'on' : ''}
            onClick={() => setViewId(v.id)}
            onDoubleClick={() => {
              if (!editable) return
              const name = prompt('Name der Ansicht', v.name)
              if (name) update((d) => void (d.views.find((x) => x.id === v.id)!.name = name))
            }}
          >
            <span className="db-tab-icon"><Icon name={v.type} /></span>
            {v.name}
          </button>
        ))}
        {editable && (
          <button className="db-tab-add" title="Ansicht hinzufügen" onClick={(e) => open({ kind: 'addView' }, e)}>+</button>
        )}
        {editable && (
          <span className="db-tab-end">
            {db.views.length > 1 && (
              <button
                title="Ansicht löschen"
                onClick={() => {
                  update((d) => void (d.views = d.views.filter((x) => x.id !== view.id)))
                  setViewId(db.views.find((x) => x.id !== view.id)?.id)
                }}
              >
                Ansicht entfernen
              </button>
            )}
            <button title="Datenbank löschen" onClick={() => confirm('Datenbank löschen?') && deleteNode()}>Löschen</button>
          </span>
        )}
      </div>

      {view.type === 'table' && <TableView {...ctx} />}
      {view.type === 'board' && <BoardView {...ctx} />}
      {view.type === 'chart' && <ChartView {...ctx} />}

      {pop && (
        <div className="db-pop" style={{ left: Math.max(0, Math.min(pop.x, (root.current?.clientWidth ?? 600) - 290)), top: pop.y }}>
          <Popover state={pop.pop} {...ctx} onViewAdded={setViewId} />
        </div>
      )}
    </NodeViewWrapper>
  )
}

interface Ctx {
  db: DbAttrs
  view: View
  rows: Row[]
  editable: boolean
  update: (fn: (d: DbAttrs) => void) => void
  updateView: (fn: (v: View) => void) => void
  setCell: (row: string, prop: string, value: Cell) => void
  addRow: (cells?: Record<string, Cell>) => string
  open: (p: Pop, e: React.MouseEvent) => void
  close: () => void
}

// ---- cells ------------------------------------------------------------------------

function Tag({ option }: { option: Option }) {
  return <span className={`tag c-${option.color}`}>{option.name}</span>
}

function CellView({ ctx, row, prop }: { ctx: Ctx; row: Row; prop: Property }) {
  const v = row.cells[prop.id]
  const set = (value: Cell) => ctx.setCell(row.id, prop.id, value)
  const ro = !ctx.editable
  switch (prop.type) {
    case 'title':
    case 'text':
      return (
        <input
          className={`cell-input ${prop.type === 'title' ? 'title' : ''}`}
          value={typeof v === 'string' ? v : ''}
          readOnly={ro}
          placeholder={prop.type === 'title' ? 'Ohne Titel' : ''}
          onChange={(e) => set(e.target.value)}
        />
      )
    case 'url':
      return (
        <span className="cell-url">
          <input className="cell-input" value={typeof v === 'string' ? v : ''} readOnly={ro} onChange={(e) => set(e.target.value)} />
          {typeof v === 'string' && v && (
            <a href={/^https?:/.test(v) ? v : `https://${v}`} target="_blank" rel="noreferrer">↗</a>
          )}
        </span>
      )
    case 'number':
      return (
        <input
          className="cell-input num"
          type="number"
          value={typeof v === 'number' ? v : ''}
          readOnly={ro}
          onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
    case 'checkbox':
      return <input type="checkbox" className="cell-check" checked={v === true} disabled={ro} onChange={(e) => set(e.target.checked)} />
    case 'date':
      return (
        <input
          className="cell-input"
          type="date"
          value={typeof v === 'string' ? v.slice(0, 10) : ''}
          readOnly={ro}
          onChange={(e) => set(e.target.value || null)}
        />
      )
    case 'select':
    case 'status':
    case 'multi_select': {
      const ids = Array.isArray(v) ? v : v ? [v as string] : []
      const opts = ids.map((id) => prop.options?.find((o) => o.id === id)).filter(Boolean) as Option[]
      return (
        <button className="cell-tags" disabled={ro} onClick={(e) => ctx.open({ kind: 'options', row: row.id, prop: prop.id }, e)}>
          {opts.map((o) => <Tag key={o.id} option={o} />)}
          {!opts.length && <span className="cell-empty"> </span>}
        </button>
      )
    }
    case 'formula': {
      const text = displayValue(ctx.db, row, prop)
      return <span className={`cell-formula ${text.startsWith('⚠') ? 'err' : ''}`} title={text}>{text}</span>
    }
  }
}

// ---- views ------------------------------------------------------------------------

function TableView(ctx: Ctx) {
  const { db, rows, editable } = ctx
  const sums = db.properties.map((p) =>
    p.type === 'number' || p.type === 'formula'
      ? rows.reduce<number | null>((s, r) => {
          const n = numericValue(db, r, p)
          return n === null ? s : (s ?? 0) + n
        }, null)
      : null,
  )
  return (
    <div className="db-table-wrap">
      <table className="db-table">
        <thead>
          <tr>
            {db.properties.map((p) => (
              <th key={p.id} className={`t-${p.type}`}>
                <button disabled={!editable} onClick={(e) => ctx.open({ kind: 'prop', prop: p.id }, e)}>
                  <span className="prop-icon"><Icon name={TYPE_ICON[p.type]} /></span>
                  {p.name}
                </button>
              </th>
            ))}
            {editable && (
              <th className="db-add-col">
                <button
                  title="Eigenschaft hinzufügen"
                  onClick={(e) => {
                    const p = newProperty('text', 'Eigenschaft')
                    ctx.update((d) => void d.properties.push(p))
                    ctx.open({ kind: 'prop', prop: p.id }, e)
                  }}
                >
                  +
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {db.properties.map((p, i) => (
                <td key={p.id} className={`t-${p.type}`}>
                  {i === 0 && editable && (
                    <button
                      className="row-del"
                      title="Zeile löschen"
                      onClick={() => ctx.update((d) => void (d.rows = d.rows.filter((x) => x.id !== r.id)))}
                    >
                      ×
                    </button>
                  )}
                  <CellView ctx={ctx} row={r} prop={p} />
                </td>
              ))}
              {editable && <td />}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {db.properties.map((p, i) => (
              <td key={p.id} className={`t-${p.type}`}>
                {i === 0 && editable ? (
                  <button className="db-add-row" onClick={() => ctx.addRow()}>+ Neue Zeile</button>
                ) : i === 0 ? (
                  <span className="db-count">{rows.length} Einträge</span>
                ) : sums[i] !== null ? (
                  <span className="db-sum">Σ {Math.round(sums[i]! * 100) / 100}</span>
                ) : null}
              </td>
            ))}
            {editable && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function BoardView(ctx: Ctx) {
  const { db, view, rows, editable } = ctx
  const groupable = db.properties.filter((p) => p.type === 'select' || p.type === 'status')
  const group = db.properties.find((p) => p.id === view.groupBy) ?? groupable[0]
  const [over, setOver] = useState<string | null>(null)
  if (!group) return <div className="db-hint">Für ein Board braucht die Datenbank eine Status- oder Auswahl-Eigenschaft.</div>
  const title = db.properties.find((p) => p.type === 'title') ?? db.properties[0]
  const columns: { id: string | null; option?: Option }[] = [...(group.options ?? []).map((o) => ({ id: o.id, option: o })), { id: null }]
  const shown = db.properties.filter((p) => p.id !== title.id && p.id !== group.id)

  return (
    <>
      {editable && groupable.length > 1 && (
        <div className="db-config">
          Gruppieren nach
          <select value={group.id} onChange={(e) => ctx.updateView((v) => void (v.groupBy = e.target.value))}>
            {groupable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="board">
        {columns.map((col) => {
          const items = rows.filter((r) => (r.cells[group.id] ?? null) === col.id || (col.id === null && !group.options?.some((o) => o.id === r.cells[group.id])))
          if (col.id === null && !items.length) return null
          const key = col.id ?? '∅'
          return (
            <div
              key={key}
              className={`board-col ${over === key ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(key)
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const id = e.dataTransfer.getData('application/x-db-row')
                if (id) ctx.setCell(id, group.id, col.id)
              }}
            >
              <div className="board-head">
                {col.option ? <Tag option={col.option} /> : <span className="tag c-gray">Ohne {group.name}</span>}
                <span className="board-count">{items.length}</span>
              </div>
              {items.map((r) => (
                <div
                  key={r.id}
                  className="board-card"
                  draggable={editable}
                  onDragStart={(e) => e.dataTransfer.setData('application/x-db-row', r.id)}
                  onClick={(e) => ctx.open({ kind: 'row', row: r.id }, e)}
                >
                  <div className="board-card-title">{(r.cells[title.id] as string) || 'Ohne Titel'}</div>
                  <div className="board-card-props">
                    {shown.map((p) => {
                      if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') {
                        const v = r.cells[p.id]
                        const ids = Array.isArray(v) ? v : v ? [v as string] : []
                        return ids.map((id) => {
                          const o = p.options?.find((x) => x.id === id)
                          return o ? <Tag key={p.id + id} option={o} /> : null
                        })
                      }
                      const t = displayValue(db, r, p)
                      if (!t || t === '✗') return null
                      const labelled = p.type === 'number' || p.type === 'formula' || p.type === 'text'
                      return (
                        <span key={p.id} className="board-prop" title={p.name}>
                          {p.type === 'date' && <Icon name="calendar" />}
                          {labelled && <span className="board-prop-name">{p.name}</span>}
                          {p.type === 'date' ? new Date(t.split('.').reverse().join('-')).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : t}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
              {editable && (
                <button className="board-add" onClick={() => ctx.addRow(col.id ? { [group.id]: col.id } : {})}>+ Neu</button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function ChartView(ctx: Ctx) {
  const { db, view, rows, editable } = ctx
  const cfg = view.chart ?? { kind: 'bar', x: db.properties[0].id, agg: 'count' as const }
  const numeric = db.properties.filter((p) => p.type === 'number' || p.type === 'formula')
  const set = (patch: Partial<typeof cfg>) => ctx.updateView((v) => void (v.chart = { ...cfg, ...patch }))
  return (
    <>
      {editable && (
        <div className="db-config">
          <select value={cfg.kind} onChange={(e) => set({ kind: e.target.value as typeof cfg.kind })}>
            <option value="bar">Balken</option>
            <option value="line">Linie</option>
            <option value="donut">Ring</option>
          </select>
          nach
          <select value={cfg.x} onChange={(e) => set({ x: e.target.value })}>
            {db.properties.filter((p) => p.type !== 'formula').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          Wert
          <select
            value={cfg.y ? `${cfg.agg}:${cfg.y}` : 'count'}
            onChange={(e) => {
              const [agg, y] = e.target.value.split(':')
              set(e.target.value === 'count' ? { agg: 'count', y: undefined } : { agg: agg as 'sum' | 'avg', y })
            }}
          >
            <option value="count">Anzahl</option>
            {numeric.flatMap((p) => [
              <option key={'s' + p.id} value={`sum:${p.id}`}>Summe {p.name}</option>,
              <option key={'a' + p.id} value={`avg:${p.id}`}>Ø {p.name}</option>,
            ])}
          </select>
        </div>
      )}
      <Chart db={db} rows={rows} config={cfg} />
    </>
  )
}

// ---- popovers ------------------------------------------------------------------------

function Popover({ state, onViewAdded, ...ctx }: Ctx & { state: Pop; onViewAdded: (id: string) => void }) {
  if (!state) return null
  switch (state.kind) {
    case 'prop':
      return <PropertyMenu ctx={ctx} propId={state.prop} />
    case 'options':
      return <OptionPicker ctx={ctx} rowId={state.row} propId={state.prop} />
    case 'filter':
      return <FilterMenu ctx={ctx} />
    case 'sort':
      return <SortMenu ctx={ctx} />
    case 'row':
      return <RowEditor ctx={ctx} rowId={state.row} />
    case 'addView':
      return (
        <div className="pop-list">
          {(['table', 'board', 'chart'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                const v = newView(t, ctx.db)
                ctx.update((d) => void d.views.push(v))
                onViewAdded(v.id)
                ctx.close()
              }}
            >
              <Icon name={t} /> {t === 'table' ? 'Tabelle' : t === 'board' ? 'Board' : 'Diagramm'}
            </button>
          ))}
        </div>
      )
  }
}

function PropertyMenu({ ctx, propId }: { ctx: Ctx; propId: string }) {
  const prop = ctx.db.properties.find((p) => p.id === propId)
  if (!prop) return null
  const edit = (fn: (p: Property) => void) => ctx.update((d) => fn(d.properties.find((p) => p.id === propId)!))
  let formulaError = ''
  if (prop.type === 'formula' && prop.formula?.trim()) {
    try {
      compile(prop.formula)
    } catch (e) {
      formulaError = (e as Error).message
    }
  }
  const types = (Object.keys(TYPE_LABEL) as PropType[]).filter((t) => t !== 'title' || prop.type === 'title')
  return (
    <div className="pop-form">
      <input className="pop-input" value={prop.name} autoFocus onChange={(e) => edit((p) => void (p.name = e.target.value))} />
      {prop.type !== 'title' && (
        <label>
          Typ
          <select
            value={prop.type}
            onChange={(e) =>
              edit((p) => {
                const t = e.target.value as PropType
                p.type = t
                if ((t === 'select' || t === 'multi_select' || t === 'status') && !p.options) p.options = newProperty(t, '').options
                if (t === 'formula' && p.formula === undefined) p.formula = ''
              })
            }
          >
            {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
      )}
      {prop.type === 'formula' && (
        <>
          <textarea
            className="pop-formula"
            value={prop.formula ?? ''}
            placeholder={'if(prop("Erledigt"), "✓", "")'}
            spellCheck={false}
            onChange={(e) => edit((p) => void (p.formula = e.target.value))}
          />
          <div className={`pop-help ${formulaError ? 'err' : ''}`}>
            {formulaError || `Eigenschaften: ${ctx.db.properties.filter((p) => p.id !== propId).map((p) => `prop("${p.name}")`).join(', ')}`}
          </div>
          <div className="pop-help">Funktionen: {FUNCTION_NAMES.join(', ')}</div>
        </>
      )}
      {(prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status') && (
        <div className="pop-options">
          {(prop.options ?? []).map((o) => (
            <div key={o.id} className="pop-option">
              <button
                className={`dot c-${o.color}`}
                title="Farbe wechseln"
                onClick={() =>
                  edit((p) => {
                    const x = p.options!.find((y) => y.id === o.id)!
                    x.color = COLORS[(COLORS.indexOf(x.color) + 1) % COLORS.length] as Color
                  })
                }
              />
              <input value={o.name} onChange={(e) => edit((p) => void (p.options!.find((y) => y.id === o.id)!.name = e.target.value))} />
              <button title="Entfernen" onClick={() => edit((p) => void (p.options = p.options!.filter((y) => y.id !== o.id)))}>×</button>
            </div>
          ))}
          <button
            className="pop-link"
            onClick={() => edit((p) => void (p.options = [...(p.options ?? []), { id: uid(), name: 'Neu', color: COLORS[(p.options?.length ?? 0) % COLORS.length] }]))}
          >
            + Option
          </button>
        </div>
      )}
      <div className="pop-row">
        <button onClick={() => (ctx.updateView((v) => void (v.sort = { prop: propId, dir: 'asc' })), ctx.close())}>↑ Aufsteigend</button>
        <button onClick={() => (ctx.updateView((v) => void (v.sort = { prop: propId, dir: 'desc' })), ctx.close())}>↓ Absteigend</button>
      </div>
      {prop.type !== 'title' && (
        <button
          className="pop-danger"
          onClick={() => {
            ctx.update((d) => {
              d.properties = d.properties.filter((p) => p.id !== propId)
              d.views.forEach((v) => {
                v.filters = v.filters.filter((f) => f.prop !== propId)
                if (v.sort?.prop === propId) v.sort = undefined
              })
            })
            ctx.close()
          }}
        >
          Eigenschaft löschen
        </button>
      )}
    </div>
  )
}

function OptionPicker({ ctx, rowId, propId }: { ctx: Ctx; rowId: string; propId: string }) {
  const [q, setQ] = useState('')
  const prop = ctx.db.properties.find((p) => p.id === propId)!
  const row = ctx.db.rows.find((r) => r.id === rowId)
  if (!row) return null
  const multi = prop.type === 'multi_select'
  const current = row.cells[propId]
  const selected = new Set(Array.isArray(current) ? current : current ? [current as string] : [])
  const options = (prop.options ?? []).filter((o) => o.name.toLowerCase().includes(q.toLowerCase()))
  const pick = (id: string) => {
    if (multi) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      ctx.setCell(rowId, propId, [...next])
    } else {
      ctx.setCell(rowId, propId, selected.has(id) ? null : id)
      ctx.close()
    }
  }
  const create = () => {
    const id = uid()
    ctx.update((d) => {
      const p = d.properties.find((x) => x.id === propId)!
      p.options = [...(p.options ?? []), { id, name: q.trim(), color: COLORS[(p.options?.length ?? 0) % COLORS.length] }]
      const r = d.rows.find((x) => x.id === rowId)!
      r.cells[propId] = multi ? [...selected, id] : id
    })
    setQ('')
    if (!multi) ctx.close()
  }
  return (
    <div className="pop-list">
      <input
        className="pop-input"
        autoFocus
        placeholder="Suchen oder anlegen"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q.trim()) {
            const hit = options.find((o) => o.name.toLowerCase() === q.trim().toLowerCase())
            if (hit) pick(hit.id)
            else create()
          }
        }}
      />
      {options.map((o) => (
        <button key={o.id} className={selected.has(o.id) ? 'on' : ''} onClick={() => pick(o.id)}>
          <Tag option={o} />
          {selected.has(o.id) && <span className="pop-check">✓</span>}
        </button>
      ))}
      {q.trim() && !options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase()) && (
        <button onClick={create}>+ „{q.trim()}“ anlegen</button>
      )}
    </div>
  )
}

function FilterMenu({ ctx }: { ctx: Ctx }) {
  const { db, view } = ctx
  const setFilters = (fn: (f: Filter[]) => void) => ctx.updateView((v) => fn(v.filters))
  return (
    <div className="pop-form wide">
      {view.filters.length === 0 && <div className="pop-help">Keine Filter – alle Einträge werden angezeigt.</div>}
      {view.filters.map((f, i) => {
        const prop = db.properties.find((p) => p.id === f.prop)
        const ops = prop ? FILTER_OPS[prop.type] : []
        const needsValue = !['empty', 'not_empty', 'checked', 'unchecked'].includes(f.op)
        return (
          <div key={i} className="pop-row">
            <select
              value={f.prop}
              onChange={(e) =>
                setFilters((fs) => {
                  const p = db.properties.find((x) => x.id === e.target.value)!
                  fs[i] = { prop: p.id, op: FILTER_OPS[p.type][0], value: '' }
                })
              }
            >
              {db.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select value={f.op} onChange={(e) => setFilters((fs) => void (fs[i].op = e.target.value as Filter['op']))}>
              {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
            </select>
            {needsValue &&
              (prop && (prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select') ? (
                <select value={f.value ?? ''} onChange={(e) => setFilters((fs) => void (fs[i].value = e.target.value))}>
                  <option value="">–</option>
                  {prop.options?.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                </select>
              ) : (
                <input
                  type={prop?.type === 'date' ? 'date' : prop?.type === 'number' ? 'number' : 'text'}
                  value={f.value ?? ''}
                  onChange={(e) => setFilters((fs) => void (fs[i].value = e.target.value))}
                />
              ))}
            <button onClick={() => setFilters((fs) => void fs.splice(i, 1))}>×</button>
          </div>
        )
      })}
      <button
        className="pop-link"
        onClick={() => setFilters((fs) => void fs.push({ prop: db.properties[0].id, op: FILTER_OPS[db.properties[0].type][0], value: '' }))}
      >
        + Filter
      </button>
    </div>
  )
}

function SortMenu({ ctx }: { ctx: Ctx }) {
  const { db, view } = ctx
  return (
    <div className="pop-form">
      <div className="pop-row">
        <select
          value={view.sort?.prop ?? ''}
          onChange={(e) => ctx.updateView((v) => void (v.sort = e.target.value ? { prop: e.target.value, dir: v.sort?.dir ?? 'asc' } : undefined))}
        >
          <option value="">Unsortiert</option>
          {db.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {view.sort && (
          <select value={view.sort.dir} onChange={(e) => ctx.updateView((v) => void (v.sort!.dir = e.target.value as 'asc' | 'desc'))}>
            <option value="asc">aufsteigend</option>
            <option value="desc">absteigend</option>
          </select>
        )}
      </div>
    </div>
  )
}

function RowEditor({ ctx, rowId }: { ctx: Ctx; rowId: string }) {
  const row = ctx.db.rows.find((r) => r.id === rowId)
  if (!row) return null
  return (
    <div className="pop-form wide">
      {ctx.db.properties.map((p) => (
        <div key={p.id} className="row-field">
          <span className="row-label">
            <span className="prop-icon"><Icon name={TYPE_ICON[p.type]} /></span> {p.name}
          </span>
          <CellView ctx={ctx} row={row} prop={p} />
        </div>
      ))}
      {ctx.editable && (
        <button
          className="pop-danger"
          onClick={() => {
            ctx.update((d) => void (d.rows = d.rows.filter((x) => x.id !== rowId)))
            ctx.close()
          }}
        >
          Eintrag löschen
        </button>
      )}
    </div>
  )
}

/** Notion-style database block: rows + typed properties + table/board/chart views. */
export const Database = Node.create({
  name: 'database',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    const d = emptyDatabase()
    const keys = ['id', 'title', 'properties', 'rows', 'views'] as const
    return Object.fromEntries(keys.map((k) => [k, { default: d[k], rendered: false }]))
  },
  parseHTML() {
    return [{ tag: 'div[data-database]', getAttrs: (el) => JSON.parse((el as HTMLElement).dataset.database ?? '{}') }]
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-database': JSON.stringify(node.attrs) })]
  },
  addNodeView() {
    return ReactNodeViewRenderer(DatabaseView, { stopEvent: () => true })
  },
})


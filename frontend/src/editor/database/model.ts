import { uid } from '../doc'
import { compile, evaluate, FormulaError, show, type Value } from './formula'
import type { Cell, DbAttrs, Filter, FilterOp, Option, Property, PropType, Row, View } from './types'

export function optionName(prop: Property, id: unknown) {
  return prop.options?.find((o) => o.id === id)?.name ?? ''
}

/** Value of a cell as the formula language sees it. */
export function cellValue(db: DbAttrs, row: Row, prop: Property, depth = 0): Value {
  const c = row.cells[prop.id] ?? null
  switch (prop.type) {
    case 'number':
      return typeof c === 'number' ? c : null
    case 'checkbox':
      return c === true
    case 'select':
    case 'status':
      return c ? optionName(prop, c) || null : null
    case 'multi_select':
      return Array.isArray(c) ? c.map((id) => optionName(prop, id)).filter(Boolean) : []
    case 'date':
      return typeof c === 'string' && c ? new Date(c + (c.length === 10 ? 'T00:00' : '')) : null
    case 'formula':
      return formulaValue(db, row, prop, depth)
    default:
      return typeof c === 'string' ? c : c === null ? '' : String(c)
  }
}

const compiled = new Map<string, ReturnType<typeof compile> | FormulaError>()

export function formulaValue(db: DbAttrs, row: Row, prop: Property, depth = 0): Value {
  if (depth > 8) throw new FormulaError('Formeln verweisen im Kreis')
  const src = prop.formula ?? ''
  if (!src.trim()) return null
  let ast = compiled.get(src)
  if (!ast) {
    try {
      ast = compile(src)
    } catch (e) {
      ast = e instanceof FormulaError ? e : new FormulaError(String(e))
    }
    compiled.set(src, ast)
  }
  if (ast instanceof FormulaError) throw ast
  return evaluate(ast, (name) => {
    const p = db.properties.find((x) => x.name === name)
    if (!p) throw new FormulaError(`Eigenschaft „${name}“ gibt es nicht`)
    return cellValue(db, row, p, depth + 1)
  })
}

/** Safe display text of any cell (formula errors show as ⚠). */
export function displayValue(db: DbAttrs, row: Row, prop: Property): string {
  try {
    return show(cellValue(db, row, prop))
  } catch (e) {
    return '⚠ ' + (e as Error).message
  }
}

export function numericValue(db: DbAttrs, row: Row, prop: Property): number | null {
  try {
    const v = cellValue(db, row, prop)
    const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN
    return isNaN(n) ? null : n
  } catch {
    return null
  }
}

// ---- filters & sorting ----------------------------------------------------------

export const FILTER_OPS: Record<PropType, FilterOp[]> = {
  title: ['contains', 'not_contains', 'is', 'empty', 'not_empty'],
  text: ['contains', 'not_contains', 'is', 'empty', 'not_empty'],
  url: ['contains', 'empty', 'not_empty'],
  number: ['is', 'is_not', 'gt', 'lt', 'empty', 'not_empty'],
  formula: ['contains', 'is', 'gt', 'lt', 'empty', 'not_empty'],
  select: ['is', 'is_not', 'empty', 'not_empty'],
  status: ['is', 'is_not', 'empty', 'not_empty'],
  multi_select: ['contains', 'not_contains', 'empty', 'not_empty'],
  date: ['is', 'gt', 'lt', 'empty', 'not_empty'],
  checkbox: ['checked', 'unchecked'],
}

export const OP_LABEL: Record<FilterOp, string> = {
  contains: 'enthält',
  not_contains: 'enthält nicht',
  is: 'ist',
  is_not: 'ist nicht',
  gt: 'größer / nach',
  lt: 'kleiner / vor',
  empty: 'ist leer',
  not_empty: 'ist nicht leer',
  checked: 'ist angehakt',
  unchecked: 'ist nicht angehakt',
}

function matches(db: DbAttrs, row: Row, f: Filter): boolean {
  const prop = db.properties.find((p) => p.id === f.prop)
  if (!prop) return true
  let v: Value
  try {
    v = cellValue(db, row, prop)
  } catch {
    return false
  }
  const text = show(v).toLowerCase()
  const want = (f.value ?? '').toLowerCase()
  const n = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : parseFloat(text)
  const wn = prop.type === 'date' ? new Date(f.value ?? '').getTime() : parseFloat(want)
  const empty = v === null || text === '' || (Array.isArray(v) && v.length === 0)
  switch (f.op) {
    case 'contains': return Array.isArray(v) ? v.some((x) => show(x).toLowerCase() === want) : text.includes(want)
    case 'not_contains': return Array.isArray(v) ? !v.some((x) => show(x).toLowerCase() === want) : !text.includes(want)
    case 'is': return prop.type === 'date' ? show(v) === show(new Date(f.value ?? '')) : text === want
    case 'is_not': return text !== want
    case 'gt': return !isNaN(n) && n > wn
    case 'lt': return !isNaN(n) && n < wn
    case 'empty': return empty
    case 'not_empty': return !empty
    case 'checked': return v === true
    case 'unchecked': return v !== true
  }
}

export function visibleRows(db: DbAttrs, view: View): Row[] {
  let rows = db.rows.filter((r) => view.filters.every((f) => matches(db, r, f)))
  const sort = view.sort
  const prop = sort && db.properties.find((p) => p.id === sort.prop)
  if (sort && prop) {
    const key = (r: Row): number | string => {
      try {
        const v = cellValue(db, r, prop)
        if (prop.type === 'select' || prop.type === 'status')
          return prop.options!.findIndex((o) => o.id === r.cells[prop.id]) // option order, like Notion
        if (typeof v === 'number') return v
        if (v instanceof Date) return v.getTime()
        if (typeof v === 'boolean') return v ? 1 : 0
        return show(v).toLowerCase()
      } catch {
        return ''
      }
    }
    rows = [...rows].sort((a, b) => {
      const x = key(a), y = key(b)
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'de')
      return sort.dir === 'asc' ? c : -c
    })
  }
  return rows
}

// ---- construction ---------------------------------------------------------------

export function newProperty(type: PropType, name: string): Property {
  const p: Property = { id: uid(), name, type }
  if (type === 'status')
    p.options = [
      { id: uid(), name: 'Offen', color: 'gray' },
      { id: uid(), name: 'In Arbeit', color: 'blue' },
      { id: uid(), name: 'Erledigt', color: 'green' },
    ]
  else if (type === 'select' || type === 'multi_select') p.options = []
  else if (type === 'formula') p.formula = ''
  return p
}

export function newView(type: View['type'], db: DbAttrs): View {
  const groupable = db.properties.find((p) => p.type === 'status' || p.type === 'select')
  const names = { table: 'Tabelle', board: 'Board', chart: 'Diagramm' }
  return {
    id: uid(),
    name: names[type],
    type,
    filters: [],
    groupBy: type === 'board' ? groupable?.id : undefined,
    chart: type === 'chart' ? { kind: 'bar', x: groupable?.id ?? db.properties[0].id, agg: 'count' } : undefined,
  }
}

export function emptyDatabase(): DbAttrs {
  const title = newProperty('title', 'Name')
  const db: DbAttrs = { id: uid(), title: 'Datenbank', properties: [title], rows: [], views: [] }
  db.rows = [1, 2, 3].map(() => ({ id: uid(), cells: {} }))
  db.views = [newView('table', db)]
  return db
}

/** Task tracker template: status board, priorities, due dates, a countdown formula and a chart. */
export function taskTracker(): DbAttrs {
  const task = newProperty('title', 'Aufgabe')
  const status = newProperty('status', 'Status')
  const prio: Property = {
    id: uid(),
    name: 'Priorität',
    type: 'select',
    options: [
      { id: uid(), name: 'Hoch', color: 'red' },
      { id: uid(), name: 'Mittel', color: 'yellow' },
      { id: uid(), name: 'Niedrig', color: 'gray' },
    ],
  }
  const due = newProperty('date', 'Fällig')
  const left: Property = {
    id: uid(),
    name: 'Tage übrig',
    type: 'formula',
    formula: 'if(prop("Status") == "Erledigt", "✓", if(empty(prop("Fällig")), "", dateBetween(prop("Fällig"), today(), "days")))',
  }
  const o = (p: Property, i: number) => (p.options as Option[])[i].id
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
  const rows: Row[] = [
    { id: uid(), cells: { [task.id]: 'Kapitel 1 zusammenfassen', [status.id]: o(status, 2), [prio.id]: o(prio, 1), [due.id]: inDays(-2) } },
    { id: uid(), cells: { [task.id]: 'Karteikarten erstellen', [status.id]: o(status, 1), [prio.id]: o(prio, 0), [due.id]: inDays(3) } },
    { id: uid(), cells: { [task.id]: 'Altklausur rechnen', [status.id]: o(status, 0), [prio.id]: o(prio, 0), [due.id]: inDays(7) } },
  ]
  const db: DbAttrs = { id: uid(), title: 'Aufgaben', properties: [task, status, prio, due, left], rows, views: [] }
  db.views = [
    newView('table', db),
    { ...newView('board', db), groupBy: status.id },
    { ...newView('chart', db), name: 'Fortschritt', chart: { kind: 'donut', x: status.id, agg: 'count' } },
  ]
  return db
}

export const emptyCell = (type: PropType): Cell => (type === 'multi_select' ? [] : type === 'checkbox' ? false : null)

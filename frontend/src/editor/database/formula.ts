/**
 * A small Notion-like formula language for database columns.
 *
 *   prop("Preis") * prop("Menge")
 *   if(prop("Erledigt"), "✓", dateBetween(prop("Fällig"), today(), "days") + " Tage")
 *
 * Operators: + - * / %  == != < <= > >=  and or not (also && || !)
 * Values: numbers, "strings", true/false, dates, lists.
 */

export type Value = number | string | boolean | Date | null | Value[]

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

export class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
    } else if (/[0-9.]/.test(c)) {
      const m = src.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i)
      if (!m) throw new FormulaError(`Unerwartetes Zeichen „${c}“`)
      out.push({ t: 'num', v: parseFloat(m[0]) })
      i += m[0].length
    } else if (c === '"' || c === "'") {
      let j = i + 1, s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++
        s += src[j++]
      }
      if (j >= src.length) throw new FormulaError('Text nicht geschlossen')
      out.push({ t: 'str', v: s })
      i = j + 1
    } else if (/[A-Za-z_äöüÄÖÜ]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_äöüÄÖÜß0-9]+/)!
      const w = m[0]
      out.push(['and', 'or', 'not'].includes(w) ? { t: 'op', v: w } : { t: 'id', v: w })
      i += w.length
    } else {
      const two = src.slice(i, i + 2)
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        out.push({ t: 'op', v: two === '&&' ? 'and' : two === '||' ? 'or' : two })
        i += 2
      } else if ('+-*/%<>(),!'.includes(c)) {
        out.push({ t: 'op', v: c === '!' ? 'not' : c })
        i++
      } else {
        throw new FormulaError(`Unerwartetes Zeichen „${c}“`)
      }
    }
  }
  return out
}

type Ast =
  | { k: 'lit'; v: Value }
  | { k: 'call'; name: string; args: Ast[] }
  | { k: 'un'; op: string; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }

const PREC: Record<string, number> = { or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }

function parse(tokens: Token[]): Ast {
  let p = 0
  const peek = () => tokens[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`„${v}“ erwartet`)
    p++
  }
  const primary = (): Ast => {
    const tk = tokens[p++]
    if (!tk) throw new FormulaError('Formel endet unerwartet')
    if (tk.t === 'num' || tk.t === 'str') return { k: 'lit', v: tk.v }
    if (tk.t === 'op' && tk.v === '(') {
      const e = expr(0)
      expect(')')
      return e
    }
    if (tk.t === 'op' && (tk.v === '-' || tk.v === 'not')) return { k: 'un', op: tk.v, a: expr(7) }
    if (tk.t === 'id') {
      if (tk.v === 'true' || tk.v === 'false') return { k: 'lit', v: tk.v === 'true' }
      if (!isOp('(')) throw new FormulaError(`„${tk.v}“ ist keine Funktion – Eigenschaften mit prop("Name")`)
      p++
      const args: Ast[] = []
      if (!isOp(')')) {
        do args.push(expr(0))
        while (isOp(',') && ++p)
      }
      expect(')')
      return { k: 'call', name: tk.v, args }
    }
    throw new FormulaError(`Unerwartet: „${tk.v}“`)
  }
  const expr = (min: number): Ast => {
    let left = primary()
    for (;;) {
      const tk = peek()
      if (!tk || tk.t !== 'op' || !(tk.v in PREC) || PREC[tk.v] < min) break
      p++
      left = { k: 'bin', op: tk.v, a: left, b: expr(PREC[tk.v] + 1) }
    }
    return left
  }
  const ast = expr(0)
  if (p < tokens.length) throw new FormulaError(`Unerwartet: „${(tokens[p] as { v: unknown }).v}“`)
  return ast
}

const DAY = 86_400_000
const isEmpty = (v: Value) => v === null || v === '' || (Array.isArray(v) && v.length === 0)
const num = (v: Value): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) return Number(v)
  return NaN
}
export function show(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
  if (v instanceof Date) return v.toLocaleDateString('de-DE')
  if (Array.isArray(v)) return v.map(show).join(', ')
  return v
}
const date = (v: Value): Date | null => {
  if (v instanceof Date) return v
  if (typeof v === 'string' && v) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'number') return new Date(v)
  return null
}
const UNITS: Record<string, number> = { days: DAY, day: DAY, tage: DAY, weeks: 7 * DAY, wochen: 7 * DAY, hours: 3_600_000, stunden: 3_600_000, minutes: 60_000 }

function addUnit(d: Date, n: number, unit: string) {
  const r = new Date(d)
  if (unit.startsWith('month') || unit.startsWith('monat')) r.setMonth(r.getMonth() + n)
  else if (unit.startsWith('year') || unit.startsWith('jahr')) r.setFullYear(r.getFullYear() + n)
  else r.setTime(r.getTime() + n * (UNITS[unit] ?? DAY))
  return r
}

type Fn = (args: Value[]) => Value
const FUNCTIONS: Record<string, Fn> = {
  concat: (a) => a.map(show).join(''),
  length: ([x]) => (Array.isArray(x) ? x.length : show(x).length),
  lower: ([x]) => show(x).toLowerCase(),
  upper: ([x]) => show(x).toUpperCase(),
  contains: ([a, b]) => (Array.isArray(a) ? a.map(show).includes(show(b)) : show(a).toLowerCase().includes(show(b).toLowerCase())),
  replace: ([a, b, c]) => show(a).split(show(b)).join(show(c)),
  join: ([a, sep]) => (Array.isArray(a) ? a.map(show).join(sep === undefined ? ', ' : show(sep)) : show(a)),
  format: ([x]) => show(x),
  toNumber: ([x]) => num(x),
  empty: ([x]) => isEmpty(x),
  round: ([x, d]) => {
    const f = 10 ** (d === undefined ? 0 : num(d))
    return Math.round(num(x) * f) / f
  },
  floor: ([x]) => Math.floor(num(x)),
  ceil: ([x]) => Math.ceil(num(x)),
  abs: ([x]) => Math.abs(num(x)),
  sqrt: ([x]) => Math.sqrt(num(x)),
  pow: ([x, y]) => num(x) ** num(y),
  min: (a) => Math.min(...a.flat().map(num)),
  max: (a) => Math.max(...a.flat().map(num)),
  sum: (a) => a.flat().map(num).filter((n) => !isNaN(n)).reduce((s, n) => s + n, 0),
  now: () => new Date(),
  today: () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  },
  dateAdd: ([d, n, u]) => (date(d) ? addUnit(date(d)!, num(n), show(u ?? 'days').toLowerCase()) : null),
  dateSubtract: ([d, n, u]) => (date(d) ? addUnit(date(d)!, -num(n), show(u ?? 'days').toLowerCase()) : null),
  dateBetween: ([a, b, u]) => {
    const x = date(a), y = date(b)
    if (!x || !y) return null
    const unit = show(u ?? 'days').toLowerCase()
    if (unit.startsWith('month') || unit.startsWith('monat'))
      return (x.getFullYear() - y.getFullYear()) * 12 + x.getMonth() - y.getMonth()
    if (unit.startsWith('year') || unit.startsWith('jahr')) return x.getFullYear() - y.getFullYear()
    return Math.floor((x.getTime() - y.getTime()) / (UNITS[unit] ?? DAY))
  },
  formatDate: ([d]) => (date(d) ? date(d)!.toLocaleDateString('de-DE') : ''),
  year: ([d]) => date(d)?.getFullYear() ?? null,
  month: ([d]) => (date(d) ? date(d)!.getMonth() + 1 : null),
  day: ([d]) => date(d)?.getDate() ?? null,
}

export const FUNCTION_NAMES = ['prop', 'if', ...Object.keys(FUNCTIONS)]

export type PropLookup = (name: string) => Value

export function compile(src: string): Ast {
  return parse(tokenize(src))
}

export function evaluate(ast: Ast, prop: PropLookup): Value {
  const ev = (n: Ast): Value => {
    switch (n.k) {
      case 'lit':
        return n.v
      case 'un': {
        const a = ev(n.a)
        return n.op === 'not' ? !truthy(a) : -num(a)
      }
      case 'bin': {
        if (n.op === 'and') return truthy(ev(n.a)) && truthy(ev(n.b))
        if (n.op === 'or') return truthy(ev(n.a)) || truthy(ev(n.b))
        const a = ev(n.a), b = ev(n.b)
        switch (n.op) {
          case '+':
            if (a instanceof Date) return new Date(a.getTime() + num(b) * DAY)
            return typeof a === 'string' || typeof b === 'string' ? show(a) + show(b) : num(a) + num(b)
          case '-':
            if (a instanceof Date && b instanceof Date) return Math.floor((a.getTime() - b.getTime()) / DAY)
            if (a instanceof Date) return new Date(a.getTime() - num(b) * DAY)
            return num(a) - num(b)
          case '*': return num(a) * num(b)
          case '/': return num(b) === 0 ? null : num(a) / num(b)
          case '%': return num(a) % num(b)
          case '==': return eq(a, b)
          case '!=': return !eq(a, b)
          case '<': return cmp(a, b) < 0
          case '>': return cmp(a, b) > 0
          case '<=': return cmp(a, b) <= 0
          case '>=': return cmp(a, b) >= 0
        }
        throw new FormulaError(`Operator ${n.op}`)
      }
      case 'call': {
        if (n.name === 'prop') {
          const name = n.args[0] ? ev(n.args[0]) : null
          return prop(show(name))
        }
        if (n.name === 'if') return truthy(ev(n.args[0])) ? (n.args[1] ? ev(n.args[1]) : null) : n.args[2] ? ev(n.args[2]) : null
        const f = FUNCTIONS[n.name]
        if (!f) throw new FormulaError(`Unbekannte Funktion „${n.name}“`)
        return f(n.args.map(ev))
      }
    }
  }
  return ev(ast)
}

function truthy(v: Value) {
  if (Array.isArray(v)) return v.length > 0
  return !!v && !(typeof v === 'number' && isNaN(v))
}
function eq(a: Value, b: Value) {
  if (a instanceof Date || b instanceof Date) return num(a) === num(b)
  if (typeof a === 'number' || typeof b === 'number') return num(a) === num(b)
  return show(a) === show(b)
}
function cmp(a: Value, b: Value) {
  const x = num(a), y = num(b)
  if (!isNaN(x) && !isNaN(y)) return x - y
  return show(a).localeCompare(show(b), 'de')
}

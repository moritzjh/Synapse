export type PropType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'formula'

/** Option colours map to the categorical chart palette (CSS --series-N). */
export const COLORS = ['gray', 'blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'] as const
export type Color = (typeof COLORS)[number]

export interface Option {
  id: string
  name: string
  color: Color
}

export interface Property {
  id: string
  name: string
  type: PropType
  options?: Option[]
  formula?: string
}

export type Cell = string | number | boolean | string[] | null

export interface Row {
  id: string
  cells: Record<string, Cell>
}

export type FilterOp = 'contains' | 'not_contains' | 'is' | 'is_not' | 'gt' | 'lt' | 'empty' | 'not_empty' | 'checked' | 'unchecked'

export interface Filter {
  prop: string
  op: FilterOp
  value?: string
}

export interface ChartConfig {
  kind: 'bar' | 'line' | 'donut'
  x: string
  y?: string // number/formula property; absent = count
  agg: 'count' | 'sum' | 'avg'
}

export interface View {
  id: string
  name: string
  type: 'table' | 'board' | 'chart'
  filters: Filter[]
  sort?: { prop: string; dir: 'asc' | 'desc' }
  groupBy?: string
  chart?: ChartConfig
}

export interface DbAttrs {
  id: string
  title: string
  properties: Property[]
  rows: Row[]
  views: View[]
}

export const TYPE_LABEL: Record<PropType, string> = {
  title: 'Titel',
  text: 'Text',
  number: 'Zahl',
  select: 'Auswahl',
  multi_select: 'Mehrfachauswahl',
  status: 'Status',
  date: 'Datum',
  checkbox: 'Checkbox',
  url: 'Link',
  formula: 'Formel',
}

export const TYPE_ICON = {
  title: 'title',
  text: 'text',
  number: 'hash',
  select: 'select',
  multi_select: 'multi',
  status: 'status',
  date: 'calendar',
  checkbox: 'check',
  url: 'link',
  formula: 'formula',
} as const satisfies Record<PropType, string>

import { EN } from './en'

/**
 * Tiny i18n: the German UI text is the key, English comes from ./en/*.
 * Missing translations fall back to the German text.
 *
 *   t('Lernen')                    → "Study"
 *   t('{n} Karten', { n: 3 })      → "3 cards"
 */

export type Lang = 'de' | 'en'
const KEY = 'synapse.lang'

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'de' || saved === 'en') return saved
  } catch {
    /* private mode */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

export const lang: Lang = detect()
/** For Intl.DateTimeFormat / toLocaleString. */
export const locale = lang === 'de' ? 'de-DE' : 'en-US'

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* ignore */
  }
  location.reload()
}

export function t(de: string, vars?: Record<string, string | number>): string {
  let s = lang === 'en' ? (EN[de] ?? de) : de
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
  return s
}

import katex from 'katex'

const MATH = /\$\$([^$]+)\$\$|(?<![\\\w])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$/g

/** Text with $…$ / $$…$$ rendered as formulas (cards store formulas as LaTeX text). */
export default function MathText({ text }: { text: string }) {
  if (!text.includes('$')) return <>{text}</>
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(MATH)) {
    if (m.index! > last) parts.push(text.slice(last, m.index))
    const display = m[1] !== undefined
    const html = katex.renderToString(display ? m[1] : m[2], { throwOnError: false, displayMode: display })
    parts.push(<span key={m.index} className="math" dangerouslySetInnerHTML={{ __html: html }} />)
    last = m.index! + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export type Doc = Record<string, unknown>

/** Accepts stored content (TipTap JSON or legacy plain text) and returns a document. */
export function toDoc(content: string): Doc {
  if (content.startsWith('{')) {
    try {
      const doc = JSON.parse(content)
      if (doc?.type === 'doc') return doc
    } catch {
      /* fall through: treat as text */
    }
  }
  const blocks: Doc[] = []
  let list: Doc[] | null = null
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^[-*] (.*)$/)
    const para = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })
    if (m) {
      if (!list) blocks.push({ type: 'bulletList', content: (list = []) })
      list.push({ type: 'listItem', content: [para(m[1])] })
    } else {
      list = null
      blocks.push(para(line))
    }
  }
  return { type: 'doc', content: blocks }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10)
}

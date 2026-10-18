import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useId, useState } from 'react'

let mermaidReady: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  mermaidReady ??= import('mermaid').then((m) => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    m.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict' })
    return m.default
  })
  return mermaidReady
}

export const EXAMPLE_DIAGRAM = `flowchart LR
  A[Notiz] -->|Embedding| B(Vektorindex)
  B --> C{Ähnlich?}
  C -->|ja| D[Kante im Graph]
  C -->|nein| E[ignorieren]`

function MermaidView({ node, updateAttributes, selected, editor }: ReactNodeViewProps) {
  const code: string = node.attrs.code
  const [editing, setEditing] = useState(code.trim() === '')
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '')

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      if (!code.trim()) return setSvg('')
      try {
        const mermaid = await loadMermaid()
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(svg)
          setError('')
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message.split('\n')[0])
        document.getElementById('d' + id)?.remove()
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [code, id])

  return (
    <NodeViewWrapper className={`mermaid-block ${selected ? 'selected' : ''}`} contentEditable={false}>
      <div className="mermaid-head">
        <span>Diagramm</span>
        {editor.isEditable && (
          <button onClick={() => setEditing((e) => !e)}>{editing ? 'Fertig' : 'Bearbeiten'}</button>
        )}
      </div>
      {editing && (
        <textarea
          className="mermaid-code"
          value={code}
          spellCheck={false}
          placeholder="Mermaid-Syntax, z. B. flowchart LR; A --> B"
          onChange={(e) => updateAttributes({ code: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
      {error ? (
        <div className="mermaid-error">{error}</div>
      ) : (
        <div className="mermaid-svg" onDoubleClick={() => setEditing(true)} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </NodeViewWrapper>
  )
}

/** Block node holding Mermaid source (flowcharts, sequence, pie, mindmap, …). */
export const Mermaid = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { code: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-mermaid]', getAttrs: (el) => ({ code: (el as HTMLElement).textContent ?? '' }) }]
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mermaid': '' }), node.attrs.code]
  },
  addNodeView() {
    return ReactNodeViewRenderer(MermaidView)
  },
})

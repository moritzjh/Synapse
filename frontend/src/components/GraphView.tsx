import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { api } from '../api'

interface Node {
  id: number
  title: string
  degree: number
}

interface Link {
  source: number
  target: number
  kind: 'link' | 'semantic'
  weight: number
}

export default function GraphView({ onOpen }: { onOpen: (id: number) => void }) {
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Link[]>([])
  const [showSemantic, setShowSemantic] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  useEffect(() => {
    api.graph().then((g) => {
      const degree = new Map<number, number>()
      for (const e of g.edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
      }
      setNodes(g.nodes.map((n) => ({ id: n.id, title: n.title, degree: degree.get(n.id) ?? 0 })))
      setEdges(g.edges)
    })
  }, [])

  // ForceGraph mutates link objects (source/target become nodes), so hand it fresh copies.
  const data = useMemo(
    () => ({
      nodes,
      links: edges.filter((e) => showSemantic || e.kind === 'link').map((e) => ({ ...e })),
    }),
    [nodes, edges, showSemantic],
  )

  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    )
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="graph" ref={box}>
      <div className="graph-legend">
        <span><i className="lg-link" /> [[Link]]</span>
        <label>
          <input type="checkbox" checked={showSemantic} onChange={(e) => setShowSemantic(e.target.checked)} />
          <i className="lg-sem" /> ähnlicher Inhalt (automatisch)
        </label>
      </div>
      <ForceGraph2D
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="#14161a"
        nodeId="id"
        nodeLabel="title"
        nodeVal={(n: Node) => 1 + n.degree}
        nodeColor={() => '#8b9cff'}
        linkColor={(l: Link) => (l.kind === 'semantic' ? '#e0a84fcc' : '#ffffff66')}
        linkWidth={(l: Link) => (l.kind === 'semantic' ? 1 + 3 * Math.max(0, l.weight - 0.4) : 1.2)}
        linkLineDash={(l: Link) => (l.kind === 'semantic' ? [3, 3] : null)}
        linkCurvature={(l: Link) => (l.kind === 'semantic' ? 0 : 0.15)}
        linkDirectionalArrowLength={(l: Link) => (l.kind === 'semantic' ? 0 : 3)}
        linkDirectionalArrowRelPos={1}
        linkLabel={(l: Link) => (l.kind === 'semantic' ? `Ähnlichkeit ${(l.weight * 100).toFixed(0)}%` : '')}
        onNodeClick={(n: Node) => onOpen(n.id)}
        nodeCanvasObjectMode={() => 'after'}
        nodeCanvasObject={(n: Node & { x?: number; y?: number }, ctx, scale) => {
          if (scale < 1.2) return
          ctx.font = `${12 / scale}px system-ui`
          ctx.fillStyle = '#c9ccd3'
          ctx.textAlign = 'center'
          ctx.fillText(n.title, n.x ?? 0, (n.y ?? 0) + 8 + 4 / scale)
        }}
      />
    </div>
  )
}

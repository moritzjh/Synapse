import { useEffect, useRef, useState } from 'react'
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
  kind: string
}

export default function GraphView({ onOpen }: { onOpen: (id: number) => void }) {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] }>({ nodes: [], links: [] })
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  useEffect(() => {
    api.graph().then((g) => {
      const degree = new Map<number, number>()
      for (const e of g.edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
      }
      setData({
        nodes: g.nodes.map((n) => ({ id: n.id, title: n.title, degree: degree.get(n.id) ?? 0 })),
        links: g.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind })),
      })
    })
  }, [])

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
      <ForceGraph2D
        graphData={data}
        width={size.w}
        height={size.h}
        backgroundColor="#14161a"
        nodeId="id"
        nodeLabel="title"
        nodeVal={(n: Node) => 1 + n.degree}
        nodeColor={() => '#8b9cff'}
        linkColor={(l: Link) => (l.kind === 'semantic' ? '#e0a84f66' : '#ffffff40')}
        linkCurvature={0.15}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
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

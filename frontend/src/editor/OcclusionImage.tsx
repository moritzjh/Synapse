import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import type { Mask } from '../api'
import { Icon } from '../components/Icons'
import { uid } from './doc'

interface Draft {
  x0: number
  y0: number
  x: number
  y: number
}

const MIN_SIZE = 0.015

function ImageView({ node, updateAttributes, selected, editor }: ReactNodeViewProps) {
  const masks: Mask[] = node.attrs.occlusions ?? []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const setMasks = (next: Mask[]) => updateAttributes({ occlusions: next.length ? next : null })

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && active) {
        e.preventDefault()
        setMasks(masks.filter((m) => m.id !== active))
        setActive(null)
      }
      if (e.key === 'Escape') setEditing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const rel = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const finishDraft = () => {
    if (!draft) return
    const x = Math.min(draft.x0, draft.x), y = Math.min(draft.y0, draft.y)
    const w = Math.abs(draft.x - draft.x0), h = Math.abs(draft.y - draft.y0)
    setDraft(null)
    if (w < MIN_SIZE || h < MIN_SIZE) return
    const mask = { id: uid(), x, y, w, h }
    setMasks([...masks, mask])
    setActive(mask.id)
  }

  const rect = (m: { x: number; y: number; w: number; h: number }) => ({
    left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`,
  })
  const draftRect = draft && {
    x: Math.min(draft.x0, draft.x), y: Math.min(draft.y0, draft.y),
    w: Math.abs(draft.x - draft.x0), h: Math.abs(draft.y - draft.y0),
  }
  const activeMask = masks.find((m) => m.id === active)

  return (
    <NodeViewWrapper className={`img-block ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`} contentEditable={false}>
      <div className="img-frame" ref={box}>
        <img src={node.attrs.src} alt={node.attrs.alt ?? ''} draggable={false} />
        {(editing || masks.length > 0) && (
          <div
            className="occl-overlay"
            onPointerDown={(e) => {
              if (!editing || (e.target as HTMLElement).closest('.occl-mask')) return
              e.preventDefault()
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              const p = rel(e)
              setActive(null)
              setDraft({ x0: p.x, y0: p.y, x: p.x, y: p.y })
            }}
            onPointerMove={(e) => draft && setDraft({ ...draft, ...rel(e) })}
            onPointerUp={finishDraft}
          >
            {masks.map((m, i) => (
              <div
                key={m.id}
                className={`occl-mask ${m.id === active ? 'active' : ''}`}
                style={rect(m)}
                onPointerDown={(e) => {
                  if (!editing) return
                  e.stopPropagation()
                  setActive(m.id)
                }}
                title={m.label || `Bereich ${i + 1}`}
              >
                <span>{editing && m.label ? m.label : i + 1}</span>
              </div>
            ))}
            {draftRect && <div className="occl-mask draft" style={rect(draftRect)} />}
          </div>
        )}
      </div>

      {editor.isEditable && (
        <div className="occl-toolbar">
          {editing ? (
            <>
              <span className="occl-hint">Rechteck ziehen = Bereich abdecken · Entf löscht</span>
              {activeMask && (
                <input
                  className="occl-label"
                  placeholder="Antwort (optional)"
                  value={activeMask.label ?? ''}
                  onChange={(e) => setMasks(masks.map((m) => (m.id === active ? { ...m, label: e.target.value } : m)))}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              )}
              <button onClick={() => setEditing(false)}>Fertig</button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} title="Bereiche abdecken – daraus wird eine Karteikarte">
              <Icon name="image" /> {masks.length ? `${masks.length} Bereiche · bearbeiten` : 'Abdecken'}
            </button>
          )}
        </div>
      )}
    </NodeViewWrapper>
  )
}

/** Image node with optional occlusion masks (stored as attrs.occlusions). */
export const OcclusionImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      occlusions: {
        default: null,
        parseHTML: (el) => {
          try {
            return JSON.parse((el as HTMLElement).dataset.occlusions ?? 'null')
          } catch {
            return null
          }
        },
        renderHTML: (attrs) => (attrs.occlusions ? { 'data-occlusions': JSON.stringify(attrs.occlusions) } : {}),
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView, {
      stopEvent: ({ event }) => !!(event.target as HTMLElement).closest?.('.occl-overlay, .occl-toolbar'),
    })
  },
})

import { useEffect, useRef } from 'react'
import type { FolderMeta } from '../api'
import { Icon } from './Icons'

/** Folder colours; the CSS variables adapt them to light and dark mode. */
export const FOLDER_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const

const EMOJIS = [
  '📁', '📚', '📖', '📝', '🎓', '🧪', '🧬', '🔬', '🧠', '💡', '📐', '📊', '💻', '🧮', '⚙️', '🌍',
  '🏛️', '⚖️', '💊', '🩺', '🎨', '🎵', '📷', '✈️', '🏠', '💼', '💰', '🗂️', '⭐', '🔥', '✅', '📌',
]

/** One emoji, including multi-codepoint ones like 🏳️‍🌈. */
type Segmenter = new () => { segment(s: string): Iterable<{ segment: string }> }
const firstGrapheme = (s: string) => {
  const Seg = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter
  if (!Seg) return [...s].slice(0, 2).join('')
  for (const { segment } of new Seg().segment(s)) return segment
  return s
}

export function FolderGlyph({ meta, open }: { meta?: FolderMeta; open?: boolean }) {
  if (meta?.icon) return <span className="folder-emoji">{meta.icon}</span>
  return (
    <span className={`folder-glyph ${meta?.color ? `fcol-${meta.color}` : ''} ${open ? 'open' : ''}`}>
      <Icon name="folder" />
    </span>
  )
}

interface PickerProps {
  meta?: FolderMeta
  onChange: (m: FolderMeta) => void
  onClose: () => void
}

/** Popover to give a folder a colour and/or an emoji. */
export function FolderPicker({ meta, onChange, onClose }: PickerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const color = meta?.color ?? ''
  const icon = meta?.icon ?? ''

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    setTimeout(() => window.addEventListener('mousedown', close))
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  return (
    <div className="folder-picker" ref={ref}>
      <div className="fp-label">Farbe</div>
      <div className="fp-colors">
        {FOLDER_COLORS.map((c) => (
          <button
            key={c}
            className={`fp-color fcol-${c} ${(color || 'gray') === c ? 'on' : ''}`}
            title={c}
            onClick={() => onChange({ color: c === 'gray' ? '' : c, icon })}
          >
            <Icon name="folder" />
          </button>
        ))}
      </div>
      <div className="fp-label">
        Symbol
        {icon && (
          <button className="link-btn" onClick={() => onChange({ color, icon: '' })}>entfernen</button>
        )}
      </div>
      <div className="fp-emojis">
        {EMOJIS.map((e) => (
          <button key={e} className={icon === e ? 'on' : ''} onClick={() => onChange({ color, icon: e })}>
            {e}
          </button>
        ))}
      </div>
      <input
        className="fp-custom"
        placeholder="Eigenes Emoji einfügen…"
        maxLength={8}
        onKeyDown={(e) => {
          const v = (e.target as HTMLInputElement).value.trim()
          if (e.key === 'Enter' && v) onChange({ color, icon: firstGrapheme(v) })
        }}
      />
    </div>
  )
}

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'

export interface MenuItem {
  title: string
  hint?: string
  icon?: string
}

interface MenuHandle {
  onKeyDown: (e: KeyboardEvent) => boolean
}

interface MenuProps {
  items: MenuItem[]
  command: (item: MenuItem) => void
  empty: string
}

const Menu = forwardRef<MenuHandle, MenuProps>(({ items, command, empty }, ref) => {
  const [index, setIndex] = useState(0)
  useEffect(() => setIndex(0), [items])

  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown') {
        setIndex((i) => (i + 1) % Math.max(items.length, 1))
        return true
      }
      if (e.key === 'ArrowUp') {
        setIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1))
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (items[index]) command(items[index])
        return true
      }
      return false
    },
  }))

  return (
    <div className="suggest-menu">
      {items.length === 0 && <div className="suggest-empty">{empty}</div>}
      {items.map((item, i) => (
        <button
          key={item.title + i}
          className={i === index ? 'active' : ''}
          onMouseEnter={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault()
            command(item)
          }}
        >
          {item.icon && <span className="suggest-icon">{item.icon}</span>}
          <span>{item.title}</span>
          {item.hint && <span className="suggest-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
})

/** Suggestion `render` that shows a keyboard-navigable popup under the cursor. */
export function menuRenderer<I extends MenuItem>(empty: string): NonNullable<SuggestionOptions<I, I>['render']> {
  return () => {
    let el: HTMLDivElement | null = null
    let root: Root | null = null
    let handle: MenuHandle | null = null

    const draw = (props: SuggestionProps<I, I>) => {
      if (!el || !root) return
      const rect = props.clientRect?.()
      if (rect) {
        const below = rect.bottom + 6
        const tooLow = below + 300 > window.innerHeight
        el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`
        el.style.top = tooLow ? '' : `${below}px`
        el.style.bottom = tooLow ? `${window.innerHeight - rect.top + 6}px` : ''
      }
      root.render(
        <Menu
          ref={(h) => {
            handle = h
          }}
          items={props.items}
          command={(item) => props.command(item as I)}
          empty={empty}
        />,
      )
    }

    return {
      onStart: (props) => {
        el = document.createElement('div')
        el.className = 'suggest-popup'
        document.body.appendChild(el)
        root = createRoot(el)
        draw(props)
      },
      onUpdate: draw,
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === 'Escape') {
          el?.remove()
          return true
        }
        return handle?.onKeyDown(event) ?? false
      },
      onExit: () => {
        const r = root
        setTimeout(() => r?.unmount())
        el?.remove()
        el = null
        root = null
      },
    }
  }
}

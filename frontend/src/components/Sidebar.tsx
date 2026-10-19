import { useEffect, useMemo, useState } from 'react'
import { api, semanticApi, type SearchHit, type Status, type Tree } from '../api'
import type { View } from '../App'
import { Icon } from './Icons'
import { ancestors, baseOf, buildTree, parentOf, type TreeNode } from './tree'

interface Props {
  tree: Tree
  view: View
  due: number
  status: Status | null
  onNavigate: (v: View) => void
  onCreateNote: (where?: { folder?: string; parentId?: number }) => void
  onChanged: () => void
}

interface Hit extends SearchHit {
  semantic?: boolean
}

const EXPANDED_KEY = 'synapse.expanded'

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

export default function Sidebar({ tree, view, due, status, onNavigate, onCreateNote, onChanged }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const nodes = useMemo(() => buildTree(tree), [tree])
  const selected = view.kind === 'note' ? view.id : null

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]))
    } catch {
      /* private mode */
    }
  }, [expanded])

  // Reveal the open note in the tree.
  useEffect(() => {
    const note = tree.notes.find((n) => n.id === selected)
    if (!note?.path) return
    const need = ancestors(note.path.replace(/\.md$/, ''))
    setExpanded((e) => (need.every((k) => e.has(k)) ? e : new Set([...e, ...need])))
  }, [selected, tree.notes])

  useEffect(() => {
    if (!query.trim()) return setHits([])
    const t = setTimeout(async () => {
      const [text, sem] = await Promise.all([api.search(query), semanticApi.search(query).catch(() => [])])
      const seen = new Set(text.map((h) => h.id))
      setHits([
        ...text,
        ...sem.filter((s) => !seen.has(s.id) && s.score > 0.3).map((s) => ({ id: s.id, title: s.title, snippet: '', semantic: true })),
      ])
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  const toggle = (key: string) =>
    setExpanded((e) => {
      const n = new Set(e)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const newFolder = async (parent: string) => {
    const name = prompt('Name des Ordners')
    if (!name?.trim()) return
    const { path } = await api.createFolder(parent ? `${parent}/${name.trim()}` : name.trim())
    setExpanded((e) => new Set([...e, parent, path]))
    onChanged()
  }

  const renameFolder = async (key: string, name: string) => {
    setRenaming(null)
    if (!name.trim() || name.trim() === baseOf(key)) return
    const parent = parentOf(key)
    await api.renameFolder(key, parent ? `${parent}/${name.trim()}` : name.trim())
    onChanged()
  }

  const deleteFolder = async (key: string) => {
    if (!confirm(`Ordner „${baseOf(key)}“ mit allen Notizen löschen? (Dateien landen im Papierkorb .trash)`)) return
    await api.deleteFolder(key)
    onChanged()
  }

  // Drop a dragged note/folder onto a folder, onto a note (→ subpage) or the root.
  const drop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()
    setDropTarget(null)
    const data = e.dataTransfer.getData('application/x-synapse')
    if (!data) return
    const item = JSON.parse(data) as { kind: 'note'; id: number } | { kind: 'folder'; key: string }
    if (item.kind === 'note') {
      await api.moveNote(item.id, targetFolder)
    } else {
      if (targetFolder === item.key || targetFolder.startsWith(item.key + '/')) return
      if (parentOf(item.key) === targetFolder) return
      await api.renameFolder(item.key, targetFolder ? `${targetFolder}/${baseOf(item.key)}` : baseOf(item.key))
    }
    if (targetFolder) setExpanded((x) => new Set([...x, targetFolder]))
    onChanged()
  }

  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('application/x-synapse')) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(target)
    },
    onDragLeave: () => setDropTarget((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.stopPropagation()
      drop(e, target)
    },
  })

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const open = expanded.has(node.key)
    const hasChildren = node.children.length > 0
    const isNote = node.kind === 'note'
    const active = isNote && node.note!.id === selected
    return (
      <li key={`${node.kind}:${node.key}`}>
        <div
          className={`tree-row ${active ? 'active' : ''} ${dropTarget === node.key ? 'drop' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={renaming !== node.key}
          onDragStart={(e) => {
            e.dataTransfer.setData(
              'application/x-synapse',
              JSON.stringify(isNote ? { kind: 'note', id: node.note!.id } : { kind: 'folder', key: node.key }),
            )
            e.dataTransfer.effectAllowed = 'move'
          }}
          {...dropProps(node.key)}
          onClick={() => (isNote ? onNavigate({ kind: 'note', id: node.note!.id }) : toggle(node.key))}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ node, x: e.clientX, y: e.clientY })
          }}
        >
          <button
            className={`twisty ${open ? 'open' : ''} ${hasChildren || !isNote ? '' : 'leaf'}`}
            onClick={(e) => {
              e.stopPropagation()
              toggle(node.key)
            }}
            tabIndex={-1}
          >
            <Icon name="chevron" />
          </button>
          <span className="tree-icon">
            <Icon name={isNote ? 'note' : 'folder'} />
          </span>
          {renaming === node.key ? (
            <input
              className="tree-rename"
              defaultValue={node.name}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => renameFolder(node.key, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <span className="tree-name">{node.name}</span>
          )}
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="icon-btn"
              title={isNote ? 'Unterseite anlegen' : 'Notiz in diesem Ordner'}
              onClick={() => {
                setExpanded((x) => new Set([...x, node.key]))
                onCreateNote(isNote ? { parentId: node.note!.id } : { folder: node.key })
              }}
            >
              <Icon name="plus" />
            </button>
            <button className="icon-btn" title="Mehr" onClick={(e) => setMenu({ node, x: e.clientX, y: e.clientY })}>
              <Icon name="more" />
            </button>
          </span>
        </div>
        {open && hasChildren && <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    )
  }

  const nav = (kind: 'graph' | 'review' | 'exams', icon: 'graph' | 'cards' | 'calendar', label: string, badge?: number) => (
    <button className={`nav-item ${view.kind === kind ? 'active' : ''}`} onClick={() => onNavigate({ kind } as View)}>
      <Icon name={icon} />
      {label}
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" /> Synapse
      </div>
      <label className="side-search">
        <Icon name="search" />
        <input placeholder="Suchen" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <nav className="nav">
        {nav('review', 'cards', 'Lernen', due)}
        {nav('exams', 'calendar', 'Prüfungen')}
        {nav('graph', 'graph', 'Graph')}
      </nav>

      <div className={`side-section ${dropTarget === '' ? 'drop' : ''}`} {...dropProps('')}>
        <span>{query.trim() ? 'Treffer' : 'Notizen'}</span>
        {!query.trim() && (
          <span className="side-section-actions">
            <button className="icon-btn" title="Neuer Ordner" onClick={() => newFolder('')}>
              <Icon name="folder" />
            </button>
            <button className="icon-btn" title="Neue Notiz" onClick={() => onCreateNote()}>
              <Icon name="plus" />
            </button>
          </span>
        )}
      </div>

      {query.trim() ? (
        <ul className="note-list">
          {hits.map((n) => (
            <li key={n.id} className={n.id === selected ? 'selected' : ''}>
              <button onClick={() => onNavigate({ kind: 'note', id: n.id })} title={n.title}>
                {n.title}
                {n.snippet && <span className="snippet" dangerouslySetInnerHTML={{ __html: escapeSnippet(n.snippet) }} />}
                {n.semantic && <span className="snippet">ähnlicher Inhalt</span>}
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="muted" style={{ padding: '4px 10px' }}>Nichts gefunden</li>}
        </ul>
      ) : (
        <ul className="tree" {...dropProps('')}>
          {nodes.map((n) => renderNode(n, 0))}
        </ul>
      )}

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.node.kind === 'folder' ? (
            <>
              <button onClick={() => { setMenu(null); onCreateNote({ folder: menu.node.key }) }}>Neue Notiz</button>
              <button onClick={() => { setMenu(null); newFolder(menu.node.key) }}>Neuer Unterordner</button>
              <button onClick={() => { setMenu(null); setRenaming(menu.node.key) }}>Umbenennen</button>
              <hr />
              <button className="danger" onClick={() => { setMenu(null); deleteFolder(menu.node.key) }}>Löschen</button>
            </>
          ) : (
            <>
              <button onClick={() => { setMenu(null); onCreateNote({ parentId: menu.node.note!.id }) }}>Unterseite anlegen</button>
              <button onClick={() => { setMenu(null); newFolder(parentOf(menu.node.key)) }}>Neuer Ordner daneben</button>
              <button onClick={() => { setMenu(null); onNavigate({ kind: 'graph', focus: menu.node.note!.id }) }}>Lokaler Graph</button>
              {parentOf(menu.node.key) && (
                <button onClick={async () => { setMenu(null); await api.moveNote(menu.node.note!.id, ''); onChanged() }}>
                  Nach oben verschieben
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="side-footer" title={status?.vault}>
        {status?.semantic.enabled ? `${status.semantic.model} · ${status.semantic.indexed} indexiert` : 'Kein Embedding-Modell'}
        <br />
        {status && `Vault: ${status.vault.split('/').slice(-2).join('/')}`}
      </div>
    </aside>
  )
}

function escapeSnippet(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)b&gt;/g, '<$1b>')
}


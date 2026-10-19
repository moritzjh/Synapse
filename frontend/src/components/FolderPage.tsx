import { useEffect, useMemo, useState } from 'react'
import { api, cardApi, titleOf, type ReviewStats, type Tree } from '../api'
import Crumbs from './Crumbs'
import { FolderGlyph, FolderPicker } from './FolderIcon'
import { Icon } from './Icons'
import { baseOf, buildTree, parentOf, type TreeNode } from './tree'

interface Props {
  path: string
  tree: Tree
  onFolder: (path: string) => void
  onNote: (id: number) => void
  onCreateNote: (where: { folder?: string }) => void
  onStudy: (path: string, name: string) => void
  onChanged: () => void
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })

function find(nodes: TreeNode[], key: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.kind === 'folder' && n.key === key) return n
    const hit = find(n.children, key)
    if (hit) return hit
  }
}

/** A folder opened in the main area: its subfolders and notes, colour/emoji, and studying its cards. */
export default function FolderPage({ path, tree, onFolder, onNote, onCreateNote, onStudy, onChanged }: Props) {
  const nodes = useMemo(() => buildTree(tree), [tree])
  const folder = path ? find(nodes, path) : undefined
  const children = path ? folder?.children ?? [] : nodes
  const name = path ? baseOf(path) : 'Notizen'
  const meta = tree.folder_meta?.[path]
  const [picking, setPicking] = useState(false)
  const [stats, setStats] = useState<ReviewStats | null>(null)

  const inside = tree.notes.filter((n) => !path || n.path.startsWith(path + '/'))
  const subfolders = children.filter((c) => c.kind === 'folder')
  const notes = children.filter((c) => c.kind === 'note')

  useEffect(() => {
    cardApi.stats(0, path).then(setStats).catch(() => setStats(null))
  }, [path, tree])

  if (path && !folder) {
    return (
      <div className="scroll">
        <div className="empty-state">
          <p>Diesen Ordner gibt es nicht mehr.</p>
          <button className="btn" onClick={() => onFolder(parentOf(path))}>Zurück</button>
        </div>
      </div>
    )
  }

  const newFolder = async () => {
    const n = prompt('Name des Unterordners')
    if (!n?.trim()) return
    await api.createFolder(path ? `${path}/${n.trim()}` : n.trim())
    onChanged()
  }

  const count = (node: TreeNode) => {
    const notesIn = tree.notes.filter((n) => n.path.startsWith(node.key + '/')).length
    const folders = node.children.filter((c) => c.kind === 'folder').length
    return [folders && `${folders} Ordner`, `${notesIn} ${notesIn === 1 ? 'Notiz' : 'Notizen'}`]
      .filter(Boolean)
      .join(' · ')
  }
  const toStudy = stats ? stats.due + stats.new : 0

  return (
    <div className="scroll">
      <div className="note-top">
        <Crumbs folder={path} tree={tree} onFolder={onFolder} onNote={onNote} currentIsLast />
      </div>
      <div className="page folder-page">
        <div className="folder-head">
          {path ? (
            <div className="folder-icon-wrap">
              <button className="folder-big" onClick={() => setPicking((p) => !p)} title="Farbe und Symbol ändern">
                <FolderGlyph meta={meta} />
              </button>
              {picking && (
                <FolderPicker
                  meta={meta}
                  onClose={() => setPicking(false)}
                  onChange={async (m) => {
                    await api.setFolderMeta(path, m)
                    onChanged()
                  }}
                />
              )}
            </div>
          ) : (
            <span className="folder-big static"><Icon name="note" /></span>
          )}
          <h1 className="page-title">{name}</h1>
        </div>

        <div className="folder-bar">
          <span className="muted">
            {subfolders.length > 0 && `${subfolders.length} Ordner · `}
            {inside.length} {inside.length === 1 ? 'Notiz' : 'Notizen'}
            {stats && stats.total > 0 && ` · ${stats.total} ${stats.total === 1 ? 'Karte' : 'Karten'}`}
          </span>
          <span className="folder-actions">
            <button className="btn ghost" onClick={() => onCreateNote({ folder: path || undefined })}>
              <Icon name="plus" /> Notiz
            </button>
            <button className="btn ghost" onClick={newFolder}>
              <Icon name="folder" /> Unterordner
            </button>
            {stats && stats.total > 0 && (
              <button className="btn study-btn" onClick={() => onStudy(path, name)}>
                <Icon name="cards" /> Lernen
                {toStudy > 0 && <span className="study-btn-count">{toStudy}</span>}
              </button>
            )}
          </span>
        </div>

        {subfolders.length > 0 && (
          <div className="folder-grid">
            {subfolders.map((f) => (
              <button key={f.key} className="folder-tile" onClick={() => onFolder(f.key)}>
                <FolderGlyph meta={tree.folder_meta?.[f.key]} />
                <span className="folder-tile-name">{f.name}</span>
                <span className="folder-tile-sub">{count(f)}</span>
              </button>
            ))}
          </div>
        )}

        {notes.length > 0 && (
          <ul className="folder-notes">
            {notes.map((n) => (
              <li key={n.key}>
                <button onClick={() => onNote(n.note!.id)}>
                  <Icon name="note" />
                  <span className={`folder-note-title ${n.note!.title.trim() ? '' : 'muted'}`}>{titleOf(n.note!.title)}</span>
                  {n.children.length > 0 && <span className="folder-note-sub">{n.children.length} Unterseiten</span>}
                  <span className="folder-note-date">{dateFmt.format(n.note!.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!subfolders.length && !notes.length && (
          <div className="folder-empty">
            <p>Dieser Ordner ist leer.</p>
            <button className="btn" onClick={() => onCreateNote({ folder: path || undefined })}>Erste Notiz anlegen</button>
          </div>
        )}
      </div>
    </div>
  )
}

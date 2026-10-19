import type { NoteSummary, Tree } from '../api'
import { FolderGlyph } from './FolderIcon'

interface Props {
  /** Folder path whose ancestors (and itself) are shown, e.g. "Uni/Bio/Zelle". */
  folder: string
  tree: Tree
  onFolder: (path: string) => void
  onNote: (id: number) => void
  /** Show the last segment as plain text (the page you are on). */
  currentIsLast?: boolean
}

/**
 * Clickable path "Notizen › Uni › Bio". A segment that is a note with
 * subpages (Obsidian folder note "Zelle.md" + "Zelle/") opens that note,
 * every other segment opens the folder.
 */
export default function Crumbs({ folder, tree, onFolder, onNote, currentIsLast }: Props) {
  const parts = folder ? folder.split('/') : []
  const byPath = new Map<string, NoteSummary>(tree.notes.map((n) => [n.path, n]))
  return (
    <nav className="crumbs">
      <button onClick={() => onFolder('')}>Notizen</button>
      {parts.map((name, i) => {
        const path = parts.slice(0, i + 1).join('/')
        const owner = byPath.get(path + '.md')
        const last = currentIsLast && i === parts.length - 1
        return (
          <span key={path} className="crumb">
            <span className="crumb-sep">›</span>
            {last ? (
              <span className="crumb-current">{name}</span>
            ) : (
              <button onClick={() => (owner ? onNote(owner.id) : onFolder(path))}>
                {!owner && tree.folder_meta?.[path]?.icon && <FolderGlyph meta={tree.folder_meta[path]} />}
                {name}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}

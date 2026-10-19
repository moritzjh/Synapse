import type { NoteSummary, Tree } from '../api'

export interface TreeNode {
  kind: 'folder' | 'note'
  name: string
  /** Folder path, or for notes the path without ".md" (= folder of its subpages). */
  key: string
  note?: NoteSummary
  children: TreeNode[]
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)

/**
 * Builds the sidebar tree from vault paths. A folder that sits next to a
 * note of the same name ("Zelle.md" + "Zelle/") is shown as that note's
 * subpages – Obsidian's folder-note convention.
 */
export function buildTree(tree: Tree): TreeNode[] {
  const root: TreeNode = { kind: 'folder', name: '', key: '', children: [] }
  const folders = new Map<string, TreeNode>([['', root]])

  const folder = (path: string): TreeNode => {
    const existing = folders.get(path)
    if (existing) return existing
    const node: TreeNode = { kind: 'folder', name: baseOf(path), key: path, children: [] }
    folders.set(path, node)
    folder(parentOf(path)).children.push(node)
    return node
  }

  tree.folders.forEach(folder)
  const notes = new Map<string, TreeNode>()
  for (const n of tree.notes) {
    const path = n.path || `${n.title}.md`
    const key = path.replace(/\.md$/, '')
    const node: TreeNode = { kind: 'note', name: n.title, key, note: n, children: [] }
    notes.set(key, node)
    folder(parentOf(key)).children.push(node)
  }

  // Fold "X/" folders into the note "X.md" next to them.
  for (const [path, f] of folders) {
    const owner = notes.get(path)
    if (!path || !owner) continue
    owner.children.push(...f.children)
    const parent = folders.get(parentOf(path))!
    parent.children = parent.children.filter((c) => c !== f)
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }),
    )
    nodes.forEach((n) => sort(n.children))
  }
  sort(root.children)
  return root.children
}

/** All ancestor keys of a path, to expand the tree up to the open note. */
export function ancestors(key: string): string[] {
  const out: string[] = []
  for (let p = parentOf(key); p; p = parentOf(p)) out.push(p)
  return out
}

export { parentOf, baseOf }

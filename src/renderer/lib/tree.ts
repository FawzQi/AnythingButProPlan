import type { FileNode } from '@shared/types'

export interface TreeRow {
  node: FileNode
  depth: number
}

/** Depth-first rows for the virtualized list, skipping collapsed subtrees. */
export function flattenTree(root: FileNode): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (node: FileNode, depth: number): void => {
    for (const child of node.children ?? []) {
      rows.push({ node: child, depth })
      if (child.type === 'directory' && child.expanded) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/** Replace one node in the tree, rebuilding only the path to it. */
export function updateNode(
  node: FileNode,
  id: string,
  update: (target: FileNode) => FileNode,
): FileNode {
  if (node.id === id) return update(node)
  if (!node.children) return node
  let changed = false
  const children = node.children.map((child) => {
    const next = updateNode(child, id, update)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

/** Apply `selected` to a node and every descendant. */
export function setSubtreeSelected(node: FileNode, selected: boolean): FileNode {
  return {
    ...node,
    selected,
    ...(node.children
      ? { children: node.children.map((child) => setSubtreeSelected(child, selected)) }
      : {}),
  }
}

export function collectSelectedPaths(node: FileNode, out: string[] = []): string[] {
  if (node.type === 'file' && node.selected) out.push(node.path)
  for (const child of node.children ?? []) collectSelectedPaths(child, out)
  return out
}

export function countFiles(node: FileNode): { selected: number; total: number } {
  let selected = 0
  let total = 0
  const walk = (current: FileNode): void => {
    if (current.type === 'file') {
      total += 1
      if (current.selected) selected += 1
    }
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return { selected, total }
}

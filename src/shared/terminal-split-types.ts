/**
 * Pane tree for terminal splits inside a single TerminalWithToolbox instance.
 * Leaves hold a ptyId; branches are horizontal ('col') or vertical ('row') splits.
 * Both node types carry a stable `id` so mutations can find them after React state updates.
 */

export type TerminalPaneId = string

export type TerminalPaneNode =
  | { type: 'pane'; id: TerminalPaneId; ptyId: string }
  | { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: TerminalPaneNode; b: TerminalPaneNode }

// ── Pure tree helpers ──────────────────────────────────────────────────────

export function countPanes(node: TerminalPaneNode): number {
  if (node.type === 'pane') return 1
  return countPanes(node.a) + countPanes(node.b)
}

export function firstPaneId(node: TerminalPaneNode): TerminalPaneId {
  if (node.type === 'pane') return node.id
  return firstPaneId(node.a)
}

export function walkPaneIds(node: TerminalPaneNode, out: TerminalPaneId[] = []): TerminalPaneId[] {
  if (node.type === 'pane') { out.push(node.id); return out }
  walkPaneIds(node.a, out)
  walkPaneIds(node.b, out)
  return out
}

export function findPane(node: TerminalPaneNode, id: TerminalPaneId): (TerminalPaneNode & { type: 'pane' }) | null {
  if (node.type === 'pane') return node.id === id ? node : null
  return findPane(node.a, id) ?? findPane(node.b, id)
}

/** Replace the pane with `id` with `replacement`. */
export function replacePaneNode(
  node: TerminalPaneNode,
  id: TerminalPaneId,
  replacement: TerminalPaneNode
): TerminalPaneNode {
  if (node.type === 'pane') return node.id === id ? replacement : node
  return { ...node, a: replacePaneNode(node.a, id, replacement), b: replacePaneNode(node.b, id, replacement) }
}

/** Remove the pane with `id`. Parent split collapses to the sibling. Returns null only if the root was removed. */
export function removePaneNode(node: TerminalPaneNode, id: TerminalPaneId): TerminalPaneNode | null {
  if (node.type === 'pane') return node.id === id ? null : node
  const a = removePaneNode(node.a, id)
  const b = removePaneNode(node.b, id)
  if (a === null) return b
  if (b === null) return a
  return { ...node, a, b }
}

/** Insert a new pane alongside `id`, creating a split node in `dir`. */
export function splitPaneNode(
  node: TerminalPaneNode,
  id: TerminalPaneId,
  dir: 'row' | 'col',
  newPane: TerminalPaneNode & { type: 'pane' },
  splitId: string
): TerminalPaneNode {
  const old = findPane(node, id)
  if (!old) return node
  const splitNode: TerminalPaneNode = { type: 'split', id: splitId, dir, ratio: 50, a: old, b: newPane }
  return replacePaneNode(node, id, splitNode)
}

/** Update the ratio of the split node with the given `splitId`. */
export function updateSplitRatio(node: TerminalPaneNode, splitId: string, ratio: number): TerminalPaneNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, ratio }
  return { ...node, a: updateSplitRatio(node.a, splitId, ratio), b: updateSplitRatio(node.b, splitId, ratio) }
}

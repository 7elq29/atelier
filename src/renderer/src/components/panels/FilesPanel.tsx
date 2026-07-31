import { useEffect, useState } from 'react'
import type { FileReadResult, FileTreeNode } from '../../../../shared/panel-types'

/**
 * Extremely small syntax highlighter: tokenizes strings/comments/numbers/
 * keywords with a handful of regexes and wraps them in spans. Not a real
 * grammar-aware highlighter (spec: "don't over-engineer") — good enough to
 * visibly distinguish tokens for common languages (JS/TS/JSON/CSS/etc).
 */
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends',
  'import', 'export', 'default', 'from', 'async', 'await', 'new', 'this', 'try', 'catch', 'throw',
  'switch', 'case', 'break', 'continue', 'typeof', 'interface', 'type', 'public', 'private', 'static',
  'def', 'elif', 'None', 'True', 'False', 'null', 'undefined', 'true', 'false', 'void', 'extends'
])

function highlightLine(line: string, key: number): JSX.Element {
  const tokenRe = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g
  const nodes: (string | JSX.Element)[] = []
  let last = 0
  let match: RegExpExecArray | null
  let idx = 0
  while ((match = tokenRe.exec(line))) {
    if (match.index > last) nodes.push(line.slice(last, match.index))
    const [full, comment, str, num, word] = match
    if (comment) nodes.push(<span className="tok-com" key={`${key}-${idx}`}>{comment}</span>)
    else if (str) nodes.push(<span className="tok-str" key={`${key}-${idx}`}>{str}</span>)
    else if (num) nodes.push(<span className="tok-num" key={`${key}-${idx}`}>{num}</span>)
    else if (word && KEYWORDS.has(word)) nodes.push(<span className="tok-key" key={`${key}-${idx}`}>{word}</span>)
    else nodes.push(full)
    last = match.index + full.length
    idx++
  }
  if (last < line.length) nodes.push(line.slice(last))
  return <div key={key}>{nodes.length > 0 ? nodes : ' '}</div>
}

function FileTree({
  nodes,
  depth,
  selected,
  onSelect
}: {
  nodes: FileTreeNode[]
  depth: number
  selected: string | null
  onSelect: (node: FileTreeNode) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <div
            className={`ft-item${n.type === 'dir' ? ' dir' : ''}${selected === n.path ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onSelect(n)}
            data-testid={n.type === 'file' ? 'file-tree-file' : 'file-tree-dir'}
            data-path={n.relativePath}
          >
            {n.type === 'dir' ? '📁' : '📄'} {n.name}
          </div>
          {n.type === 'dir' && n.children && <FileTree nodes={n.children} depth={depth + 1} selected={selected} onSelect={onSelect} />}
        </div>
      ))}
    </>
  )
}

/**
 * Files/Explorer panel (07-secondary-panels §3): real `fs`-backed tree of
 * the session's project folder, a minimal syntax-highlighted text viewer,
 * and real image / sandboxed-HTML previews.
 */
export default function FilesPanel({ projectPath }: { projectPath: string }): JSX.Element {
  const [tree, setTree] = useState<FileTreeNode[] | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileResult, setFileResult] = useState<FileReadResult | null>(null)
  const [find, setFind] = useState('')

  useEffect(() => {
    void window.gardenia.filesTree(projectPath).then(setTree)
  }, [projectPath])

  async function handleSelect(node: FileTreeNode): Promise<void> {
    if (node.type === 'dir') return
    setSelectedPath(node.path)
    const result = await window.gardenia.filesRead(node.path)
    setFileResult(result)
  }

  const lines = fileResult?.kind === 'text' ? fileResult.content.split('\n') : []
  const visibleLines = find.trim() ? lines.filter((l) => l.toLowerCase().includes(find.toLowerCase())) : lines

  return (
    <div data-testid="files-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {tree === null ? (
        <div className="empty-main" style={{ height: '100%' }}>
          <div className="empty-icon">📁</div>
          <div>Loading files…</div>
        </div>
      ) : tree.length === 0 ? (
        <div className="empty-main" style={{ height: '100%' }}>
          <div className="empty-icon icon-standalone">📁</div>
          <div>Project files will appear here</div>
        </div>
      ) : (
        <div className="files-body">
          <div className="files-tree" data-testid="files-tree">
            <FileTree nodes={tree} depth={0} selected={selectedPath} onSelect={(n) => void handleSelect(n)} />
          </div>
          <div className="file-view" data-testid="file-view">
            {!fileResult && <div style={{ color: 'var(--text-tertiary)' }}>Select a file to preview</div>}
            {fileResult?.kind === 'image' && (
              <img className="file-preview-image" src={fileResult.content} alt={selectedPath ?? ''} data-testid="file-preview-image" />
            )}
            {fileResult?.kind === 'html' && (
              <iframe
                className="file-preview-html"
                data-testid="file-preview-html"
                title="html preview"
                sandbox=""
                srcDoc={fileResult.content}
              />
            )}
            {fileResult?.kind === 'binary' && <div style={{ color: 'var(--text-tertiary)' }}>Binary file — no preview available</div>}
            {fileResult?.kind === 'text' && (
              <>
                <div className="find-row">
                  <input
                    className="input"
                    placeholder="Find in file…"
                    style={{ flex: 1 }}
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    data-testid="file-find-input"
                  />
                </div>
                <pre data-testid="file-content">{visibleLines.map((line, i) => highlightLine(line, i))}</pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import {
  TASK_PRIORITY_OPTIONS,
  formatPriorityInlineField,
  priorityDisplayLabel
} from '../../../shared/task-priority'

const TASK_LINE_RE = /^(\s*(?:>\s*)?- \[[ xX>/\-]\])/

function taskLineAt(doc: { lineAt: (pos: number) => { text: string } }, pos: number): boolean {
  const line = doc.lineAt(pos)
  return TASK_LINE_RE.test(line.text)
}

function priorityCompletions(context: CompletionContext): CompletionResult | null {
  if (!taskLineAt(context.state.doc, context.pos)) return null

  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  if (!/\[$/.test(before) && !/\[[\w]*$/.test(before)) return null

  const from = context.pos - (before.match(/\[[\w]*$/)?.[0]?.length ?? 1)

  const options: Completion[] = TASK_PRIORITY_OPTIONS.map((opt) => ({
    label: `priority:: ${opt.menuLabel}`,
    apply: formatPriorityInlineField(opt.value),
    type: 'keyword'
  }))

  return { from, options, validFor: /^(\[[\w]*)?$/ }
}

/** Autocomplete `[priority:: …]` on markdown task lines. */
export function taskPriorityAutocompletion(): ReturnType<typeof autocompletion> {
  return autocompletion({
    override: [priorityCompletions],
    activateOnTyping: true,
    defaultKeymap: true
  })
}

class PriorityBadgeWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }

  eq(other: PriorityBadgeWidget): boolean {
    return other.label === this.label
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'dn-priority-badge cm-priority-inline'
    el.textContent = this.label
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const PRIORITY_FIELD_RE = /\[priority::\s*([^\]]+)\]/g

/** In live preview, replace `[priority:: high]` with a compact badge when the caret is outside the token. */
export function taskPriorityInlinePreview(): ReturnType<typeof ViewPlugin.fromClass> {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }

      update(update: { docChanged: boolean; selectionSet: boolean; view: EditorView }): void {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.build(update.view)
        }
      }

      build(view: EditorView): DecorationSet {
        const widgets: { from: number; to: number; widget: PriorityBadgeWidget }[] = []
        const sel = view.state.selection.main

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to)
          let match: RegExpExecArray | null
          PRIORITY_FIELD_RE.lastIndex = 0
          while ((match = PRIORITY_FIELD_RE.exec(text)) !== null) {
            const start = from + match.index
            const end = start + match[0].length
            if (sel.from >= start && sel.to <= end) continue
            if (!taskLineAt(view.state.doc, start)) continue
            widgets.push({
              from: start,
              to: end,
              widget: new PriorityBadgeWidget(priorityDisplayLabel(match[1] ?? ''))
            })
          }
        }

        return Decoration.set(
          widgets.map((w) => Decoration.replace({ widget: w.widget }).range(w.from, w.to))
        )
      }
    },
    { decorations: (v) => v.decorations }
  )
}

/** Combined CodeMirror extensions for task priority in markdown notes. */
export function taskPriorityMarkdownExtensions(): Extension[] {
  return [taskPriorityAutocompletion(), taskPriorityInlinePreview() as unknown as Extension]
}

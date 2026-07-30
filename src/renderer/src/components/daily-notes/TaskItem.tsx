import type { DailyTask } from '../../../../shared/daily-note-types'

interface TaskItemProps {
  task: DailyTask
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  draggable?: boolean
}

/** A single "chip" row used by the Unscheduled section (and, without the
 * delete affordance, could be reused elsewhere). Matches the mock's
 * `.task-chip` markup/classnames. */
export default function TaskItem({ task, onToggle, onDelete, draggable = true }: TaskItemProps): JSX.Element {
  return (
    <div
      className={`dn-task-chip${task.status === 'done' ? ' done' : ''}`}
      data-testid="unscheduled-task"
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
    >
      <div className="dn-tbox" onClick={() => onToggle(task.id)} />
      <span onClick={() => onToggle(task.id)}>{task.text}</span>
      <button className="btn btn-icon btn-sm dn-task-chip-remove" onClick={() => onDelete(task.id)}>
        ✕
      </button>
    </div>
  )
}

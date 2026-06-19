"use client";

import { useState } from "react";

import {
  ClientTaskModal,
  type ClientTask,
} from "@/components/projects/client-task-modal";
import {
  KanbanBoard,
  type BoardStatus,
} from "@/components/projects/kanban-board";

/**
 * Public client board: read-only kanban where clicking a card opens a read-only
 * task detail modal (description, details, subtasks). No editing, no
 * drag. ClientTask is a superset of the board's BoardTask, so the same array
 * feeds the board and the modal lookup.
 */
export function ClientBoardTasks({
  projectId,
  statuses,
  tasks,
  // When false (owner hid full task descriptions), cards are not clickable and
  // no detail modal opens — clicking a card returns nothing.
  allowTaskDetail = true,
}: {
  projectId: string;
  statuses: BoardStatus[];
  tasks: ClientTask[];
  allowTaskDetail?: boolean;
}) {
  const [selected, setSelected] = useState<ClientTask | null>(null);

  return (
    <>
      <KanbanBoard
        projectId={projectId}
        statuses={statuses}
        readOnly
        showFilters
        scrollColumns
        tasks={tasks}
        onSelectTask={
          allowTaskDetail
            ? (task) =>
                setSelected(tasks.find((item) => item.id === task.id) ?? null)
            : undefined
        }
      />
      {allowTaskDetail ? (
        <ClientTaskModal task={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}

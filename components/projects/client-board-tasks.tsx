"use client";

import { useState } from "react";

import {
  ClientTaskModal,
  type ClientTask,
} from "@/components/projects/client-task-modal";
import { KanbanBoard } from "@/components/projects/kanban-board";

/**
 * Public client board: read-only kanban where clicking a card opens a read-only
 * task detail modal (description, details, subtasks). No editing, no
 * drag. ClientTask is a superset of the board's BoardTask, so the same array
 * feeds the board and the modal lookup.
 */
export function ClientBoardTasks({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: ClientTask[];
}) {
  const [selected, setSelected] = useState<ClientTask | null>(null);

  return (
    <>
      <KanbanBoard
        projectId={projectId}
        readOnly
        showFilters
        previewLimit={5}
        tasks={tasks}
        onSelectTask={(task) =>
          setSelected(tasks.find((item) => item.id === task.id) ?? null)
        }
      />
      <ClientTaskModal task={selected} onClose={() => setSelected(null)} />
    </>
  );
}

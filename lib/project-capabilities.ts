// Pure, dependency-free catalog + resolver for the per-project "Member Access"
// RBAC. No DB / Next / server imports, so it's safe to import from client
// components and unit tests. The DB-backed checks live in lib/authz
// (getProjectMemberPermissions, canProjectCapability), which re-exports these.

export type ProjectCapability =
  | "task.write"
  | "checklist.write"
  | "comment.write"
  | "request.write"
  | "label.apply"
  | "branch.write"
  | "taxonomy.manage"
  | "note.write"
  | "project.edit"
  | "status.publish";

export type ProjectCapabilityDef = {
  key: ProjectCapability;
  label: string;
  description: string;
  group: "Work" | "Manage";
  // The default for the Member role when the project hasn't overridden it.
  defaultForMember: boolean;
};

// The full catalog, in display order. Drives both the authz defaults and the
// "Member Access" modal UI, so there's a single source of truth. Defaults
// reproduce today's rules: the work a Member could already do is ON; Leader-level
// management is OFF (an owner/leader can opt a project's Members into it).
export const PROJECT_CAPABILITIES: readonly ProjectCapabilityDef[] = [
  {
    key: "task.write",
    label: "Tasks",
    description: "Create, edit, move between columns, and delete tasks.",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "checklist.write",
    label: "Checklists",
    description: "Add, tick off, edit, and remove a task's checklist items.",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "comment.write",
    label: "Comments",
    description: "Comment on tasks and client requests.",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "request.write",
    label: "Client requests",
    description: "Create, edit, and delete items in the request inbox.",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "label.apply",
    label: "Apply labels",
    description:
      "Tag tasks with existing labels. (Setting a task's category is part of editing the task.)",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "branch.write",
    label: "Branches",
    description:
      "Create branches, move tasks between branches, and manage branches they created.",
    group: "Work",
    defaultForMember: true,
  },
  {
    key: "taxonomy.manage",
    label: "Manage label & category definitions",
    description:
      "Create, rename, and delete the labels and categories themselves (not just apply them).",
    group: "Manage",
    defaultForMember: false,
  },
  {
    key: "note.write",
    label: "Project notes",
    description: "Create, edit, and delete project notes.",
    group: "Manage",
    defaultForMember: false,
  },
  {
    key: "project.edit",
    label: "Project details",
    description: "Edit project name, summary, status, deadline, and color.",
    group: "Manage",
    defaultForMember: false,
  },
  {
    key: "status.publish",
    label: "Client status updates",
    description: "Publish and remove client-facing status updates.",
    group: "Manage",
    defaultForMember: false,
  },
];

export const CAPABILITY_DEFAULTS = Object.fromEntries(
  PROJECT_CAPABILITIES.map((c) => [c.key, c.defaultForMember]),
) as Record<ProjectCapability, boolean>;

const CAPABILITY_KEYS = new Set<string>(PROJECT_CAPABILITIES.map((c) => c.key));

/** Type guard: is `key` a known capability key? */
export function isProjectCapability(key: string): key is ProjectCapability {
  return CAPABILITY_KEYS.has(key);
}

/**
 * Minimal storage form for a resolved permission map: keep only the capabilities
 * whose value differs from the current code default. Returns null when nothing
 * differs (store SQL NULL). This is what honors the "absent key → use the code
 * default, so defaults can evolve without a backfill" contract — an unchanged or
 * default-equal toggle is never frozen as an explicit override.
 */
export function packMemberPermissions(
  perms: Record<ProjectCapability, boolean>,
): string | null {
  const delta: Partial<Record<ProjectCapability, boolean>> = {};
  for (const c of PROJECT_CAPABILITIES) {
    if (perms[c.key] !== c.defaultForMember) delta[c.key] = perms[c.key];
  }
  return Object.keys(delta).length ? JSON.stringify(delta) : null;
}

/**
 * Resolve a stored member_permissions JSON string into a complete capability
 * map: known boolean overrides win, everything else (unknown keys, bad types,
 * malformed JSON, null/undefined) falls back to the code default. Pure — used by
 * both the cached DB resolver and the update API's validation.
 */
export function resolveMemberPermissions(
  raw: string | null | undefined,
): Record<ProjectCapability, boolean> {
  const resolved = { ...CAPABILITY_DEFAULTS };
  if (!raw) return resolved;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (CAPABILITY_KEYS.has(key) && typeof value === "boolean") {
        resolved[key as ProjectCapability] = value;
      }
    }
  } catch {
    // Malformed JSON — fall back to defaults rather than throwing in authz.
  }
  return resolved;
}

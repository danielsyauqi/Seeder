// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projectStatusValues = [
  "production",
  "development",
  "poc",
  "on_hold",
  "completed",
] as const;

export const requestStatusValues = [
  "new",
  "reviewed",
  "converted",
  "closed",
] as const;

export const taskStatusValues = ["todo", "doing", "done"] as const;

export const priorityValues = ["low", "medium", "high"] as const;

export const dailyTaskKindValues = ["adhoc", "project"] as const;

export const activityEntityValues = [
  "project",
  "request",
  "task",
  "note",
  "branch",
] as const;

export const activityActionValues = [
  "created",
  "updated",
  "deleted",
  "archived",
  "restored",
  "duplicated",
  "converted",
  "moved",
] as const;

/**
 * One field-level diff attached to a project_activity row. Powers the History
 * "Show details" before→after modal. `kind` tells the UI how to render the
 * values: "text" = plain string, "rich" = TipTap JSON to render read-only.
 * A `null` from/to means the field was empty/unset on that side.
 */
export type ActivityChange = {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
  kind: "text" | "rich";
};

export const userRoleValues = ["owner", "admin", "member"] as const;
export type UserRole = (typeof userRoleValues)[number];

// Per-project role stored on project_members. The project Owner is NOT a member
// row — it's projects.ownerId — so membership rows are only "leader" or
// "member". Leaders run the project day-to-day (config, content, add Members);
// Members do task/request work. See lib/authz.ts for the capability gates.
export const projectMemberRoleValues = ["leader", "member"] as const;
export type ProjectMemberRole = (typeof projectMemberRoleValues)[number];

// A Space groups projects. "personal" = one private space per user (only the
// owner + workspace admins see its projects). "company" = a named, shared space
// an admin creates; its members get baseline access to ALL its projects, and a
// Space Lead (spaces.leadId) + admins manage it. Every project has a spaceId.
export const spaceKindValues = ["personal", "company"] as const;
export type SpaceKind = (typeof spaceKindValues)[number];

// Scope of a personal access token. `read` = query-only MCP tools; `readwrite`
// = also allowed to mutate. A token never exceeds its owner's project access.
export const tokenScopeValues = ["read", "readwrite"] as const;
export type TokenScope = (typeof tokenScopeValues)[number];

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    role: text("role", { enum: userRoleValues }).notNull().default("member"),
    // Soft-delete: when set, the user is deactivated — blocked from every
    // guarded route (getViewer returns null) and their sessions are purged.
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    // "Clear all notifications" watermark: notifications created at or before
    // this instant are hidden. One cheap update clears everything (including
    // live-computed items that have no row to delete), and it can't hit D1's
    // bound-parameter limit the way a per-notification read insert can.
    notificationsClearedAt: integer("notifications_cleared_at", {
      mode: "timestamp_ms",
    }),
    // The user's personal sidebar project order — a JSON array of project ids.
    // Projects not listed fall to the end in their default order; ids for
    // projects the user can no longer see are simply ignored on read.
    sidebarProjectOrder: text("sidebar_project_order"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex("user_email_idx").on(table.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("session_token_idx").on(table.token),
    index("session_user_idx").on(table.userId),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("account_provider_lookup_idx").on(
      table.providerId,
      table.accountId,
    ),
    index("account_user_idx").on(table.userId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("verification_value_idx").on(table.value),
    index("verification_identifier_idx").on(table.identifier),
  ],
);

/**
 * Personal access tokens (PATs) for programmatic / MCP access. A token
 * authenticates as its owning user with a read|readwrite scope and is bounded
 * by that user's own project access. Only a SHA-256 hash of the full raw token
 * is stored — the raw value is returned once at creation and never persisted.
 * Deleting a user cascades (mirrors session/account).
 */
export const personalAccessToken = sqliteTable(
  "personal_access_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // SHA-256 hex of the full raw token (prefix + secret). Verify-time lookup key.
    tokenHash: text("token_hash").notNull(),
    // Leading chars of the raw token (e.g. "seed_pat_AbC123"), shown in the list
    // UI so a user can recognize a token without it being recoverable.
    tokenPrefix: text("token_prefix").notNull(),
    scope: text("scope", { enum: tokenScopeValues }).notNull().default("read"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("personal_access_token_hash_idx").on(table.tokenHash),
    index("personal_access_token_user_idx").on(table.userId, table.createdAt),
  ],
);

// Spaces own projects. Defined before `projects` because projects.spaceId
// references it. Personal spaces cascade-delete with their owner; company
// spaces survive their lead/creator being removed (SET NULL).
export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: spaceKindValues }).notNull(),
    name: text("name").notNull(),
    // Sole owner of a PERSONAL space (NULL for company). Deleting the user
    // removes their personal space (their projects cascade off the user too).
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    // Space Lead for a COMPANY space (NULL for personal, or if the lead is
    // removed — admins still manage it). SET NULL so a shared space survives.
    leadId: text("lead_id").references(() => user.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("spaces_owner_idx").on(table.ownerId),
    // At most one personal space per user.
    uniqueIndex("spaces_personal_owner_idx")
      .on(table.ownerId)
      .where(sql`${table.kind} = 'personal'`),
  ],
);

// Membership of a COMPANY space → baseline access to all its projects.
export const spaceMembers = sqliteTable(
  "space_members",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    addedById: text("added_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("space_members_space_user_idx").on(table.spaceId, table.userId),
    // Load-bearing: the access-resolution query joins by userId on every page.
    index("space_members_user_idx").on(table.userId),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The space this project belongs to. Nullable at the DB level only (SQLite
    // can't ALTER ADD a NOT NULL FK); every write path sets it and migration
    // 0032 backfills existing rows to each owner's Personal space.
    spaceId: text("space_id").references(() => spaces.id),
    name: text("name").notNull(),
    slug: text("slug"),
    clientName: text("client_name"),
    summary: text("summary"),
    status: text("status", { enum: projectStatusValues })
      .notNull()
      .default("development"),
    deadline: integer("deadline", { mode: "timestamp_ms" }),
    color: text("color"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    // Opt-in public client board. Private until enabled; reached via a
    // rotatable share token rather than the project id.
    clientShareEnabled: integer("client_share_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    clientShareToken: text("client_share_token"),
    // Per-project visibility toggles for the public client board. Default true
    // so existing boards keep showing everything; owners can hide each section.
    clientShareShowBoard: integer("client_share_show_board", { mode: "boolean" })
      .notNull()
      .default(true),
    clientShareShowDescription: integer("client_share_show_description", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    clientShareShowCommits: integer("client_share_show_commits", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    // Per-project overrides for what the "member" role may do, as a JSON map of
    // capability-key → boolean. NULL (and any absent key) means "use the code
    // default" in lib/authz, so default rules can evolve without a backfill.
    // Owners/Leaders/admins are unaffected — this only relaxes/restricts Members.
    memberPermissions: text("member_permissions"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("projects_owner_idx").on(table.ownerId),
    index("projects_space_idx").on(table.spaceId),
    index("projects_status_idx").on(table.status),
    // Partial uniques (matching the migrations): NULLs are exempt so multiple
    // projects may have no slug / no share token.
    uniqueIndex("projects_slug_idx")
      .on(table.slug)
      .where(sql`${table.slug} is not null`),
    uniqueIndex("projects_client_share_token_idx")
      .on(table.clientShareToken)
      .where(sql`${table.clientShareToken} is not null`),
  ],
);

// Git-like workstreams within a project. Tasks and requests are scoped to a
// branch (gain a branchId), so the Main branch and a feature branch show a
// different set of work. Every project owns exactly one default "Main" branch
// (created with the project); members can add more. Branches are public to all
// project members — anyone in the project can view/switch to any branch.
export const branches = sqliteTable(
  "branches",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Branches are shared and must outlive their creator, so this FK clears
    // (set null) rather than cascading on user deletion — unlike authorId FKs.
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // The auto-created "Main" branch. Exactly one per project, enforced by the
    // partial unique index below; Main cannot be deleted (guarded in services).
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("branches_project_idx").on(table.projectId),
    uniqueIndex("branches_project_name_idx").on(table.projectId, table.name),
    // At most one default (Main) branch per project.
    uniqueIndex("branches_project_default_idx")
      .on(table.projectId)
      .where(sql`${table.isDefault} = 1`),
  ],
);

export const projectActivity = sqliteTable(
  "project_activity",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: activityEntityValues }).notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action", { enum: activityActionValues }).notNull(),
    label: text("label").notNull(),
    detail: text("detail"),
    // Structured before→after diffs (JSON array of ActivityChange). Nullable;
    // pre-existing rows and event-only entries simply have no changes.
    changes: text("changes", { mode: "json" }).$type<ActivityChange[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("project_activity_owner_idx").on(table.ownerId),
    index("project_activity_project_idx").on(table.projectId),
    index("project_activity_created_idx").on(table.createdAt),
  ],
);

export const clientRequests = sqliteTable(
  "client_requests",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Branch this requirement belongs to. Nullable at the DB level only because
    // SQLite can't ALTER ADD a NOT NULL FK; every write path sets it (defaults
    // to the project's Main branch), and the migration backfills existing rows.
    branchId: text("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    codeNumber: integer("code_number"),
    status: text("status", { enum: requestStatusValues })
      .notNull()
      .default("new"),
    priority: text("priority", { enum: priorityValues })
      .notNull()
      .default("medium"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("requests_project_idx").on(table.projectId),
    index("requests_branch_idx").on(table.branchId),
    index("requests_owner_idx").on(table.ownerId),
    index("requests_status_idx").on(table.status),
    uniqueIndex("requests_project_code_idx")
      .on(table.projectId, table.codeNumber)
      .where(sql`${table.codeNumber} is not null`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Branch this task belongs to. Nullable at the DB level only because SQLite
    // can't ALTER ADD a NOT NULL FK; every write path sets it (defaults to the
    // project's Main branch), and the migration backfills existing rows.
    branchId: text("branch_id").references(() => branches.id, {
      onDelete: "cascade",
    }),
    requestId: text("request_id").references(() => clientRequests.id, {
      onDelete: "set null",
    }),
    assigneeId: text("assignee_id").references(() => user.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    codeNumber: integer("code_number"),
    // Matches migration 0015 (REFERENCES task_categories(id) ON DELETE SET NULL)
    // so the Drizzle model and the applied DB agree on referential behavior.
    categoryId: text("category_id").references(() => taskCategories.id, {
      onDelete: "set null",
    }),
    categoryName: text("category_name"),
    categoryColor: text("category_color"),
    phase: text("phase"),
    // Per-project custom status. The fixed todo/doing/done enum was replaced by
    // a FK into task_statuses (migration 0034). statusName/statusColor/isTerminal
    // are denormalized off the status row — mirroring categoryName/categoryColor —
    // so every read surface (board, Today, dashboard, CSV, MCP, activity) reads
    // them directly instead of joining, and every former `status === "done"`
    // check re-keys onto isTerminal. The status service resyncs these whenever a
    // status is renamed / recolored / retyped.
    statusId: text("status_id")
      .notNull()
      .references(() => taskStatuses.id),
    statusName: text("status_name").notNull(),
    statusColor: text("status_color").notNull(),
    isTerminal: integer("is_terminal", { mode: "boolean" })
      .notNull()
      .default(false),
    priority: text("priority", { enum: priorityValues })
      .notNull()
      .default("medium"),
    dueDate: integer("due_date", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),
    // When the task last entered its current status column — set on create and
    // refreshed on every status change / board drag. Powers the "in <status>
    // since <date>" label on task cards. Nullable: backfilled to updatedAt.
    statusChangedAt: integer("status_changed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("tasks_project_idx").on(table.projectId),
    index("tasks_branch_idx").on(table.branchId),
    index("tasks_owner_idx").on(table.ownerId),
    index("tasks_assignee_idx").on(table.assigneeId),
    index("tasks_status_sort_idx").on(table.statusId, table.sortOrder),
    // Board reads filter by branch then group by status and order by sortOrder.
    index("tasks_branch_status_sort_idx").on(
      table.branchId,
      table.statusId,
      table.sortOrder,
    ),
    index("tasks_status_changed_at_idx").on(table.statusChangedAt),
    index("tasks_request_idx").on(table.requestId),
    index("tasks_category_idx").on(table.categoryId),
    uniqueIndex("tasks_project_code_idx")
      .on(table.projectId, table.codeNumber)
      .where(sql`${table.codeNumber} is not null`),
  ],
);

export const taskCategories = sqliteTable(
  "task_categories",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("task_categories_project_name_idx").on(
      table.projectId,
      table.name,
    ),
    index("task_categories_project_idx").on(table.projectId),
  ],
);

// Multi-tag labels: like task categories (reusable per-project name + color),
// but many-to-many — a task can carry several labels (vs. a single category).
// Membership lives in the task_task_labels join table rather than denormalized
// onto the task row.
export const taskLabels = sqliteTable(
  "task_labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("task_labels_project_name_idx").on(table.projectId, table.name),
    index("task_labels_project_idx").on(table.projectId),
  ],
);

// Per-project board columns (Jira-style custom statuses). Replaces the fixed
// todo/doing/done enum on tasks. Modeled on task_categories: per-project name +
// color, plus ordering and two flags that carry the semantics the codebase used
// to hardcode against the "done" literal:
//   - isInitial:  the column a newly-created task lands in (was: default "todo")
//   - isTerminal: a "done"-equivalent column (drives completion %, overdue
//                 suppression, the client status-update publish gate, etc.)
// Each project keeps >= 1 status, exactly >= 1 initial, and >= 1 terminal — the
// service enforces these invariants. tasks.statusId FK has no ON DELETE cascade
// (deleting a status with tasks is blocked at the service layer; the DB FK adds
// a NO ACTION backstop).
export const taskStatuses = sqliteTable(
  "task_statuses",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isTerminal: integer("is_terminal", { mode: "boolean" })
      .notNull()
      .default(false),
    isInitial: integer("is_initial", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("task_statuses_project_name_idx").on(
      table.projectId,
      table.name,
    ),
    index("task_statuses_project_idx").on(table.projectId),
    index("task_statuses_project_sort_idx").on(table.projectId, table.sortOrder),
  ],
);

export const taskTaskLabels = sqliteTable(
  "task_task_labels",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => taskLabels.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("task_task_labels_task_label_idx").on(
      table.taskId,
      table.labelId,
    ),
    index("task_task_labels_label_idx").on(table.labelId),
  ],
);

export const taskChecklistItems = sqliteTable(
  "task_checklist_items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    isCompleted: integer("is_completed", { mode: "boolean" })
      .notNull()
      .default(false),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("task_checklist_items_task_idx").on(table.taskId),
    index("task_checklist_items_project_idx").on(table.projectId),
    index("task_checklist_items_owner_idx").on(table.ownerId),
    index("task_checklist_items_sort_idx").on(table.taskId, table.sortOrder),
    index("task_checklist_items_completed_at_idx").on(table.completedAt),
  ],
);

export const projectStatusUpdates = sqliteTable(
  "project_status_updates",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("project_status_updates_task_idx").on(table.taskId),
    index("project_status_updates_project_idx").on(table.projectId),
    index("project_status_updates_owner_idx").on(table.ownerId),
    index("project_status_updates_created_idx").on(table.createdAt),
  ],
);

export const projectNotes = sqliteTable(
  "project_notes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    // Many notes per project, ordered newest-first by created_at.
    index("project_notes_project_idx").on(table.projectId),
    index("project_notes_owner_idx").on(table.ownerId),
    index("project_notes_created_idx").on(table.createdAt),
  ],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Per-project role. "member" by default; "leader" is granted by the owner.
    role: text("role", { enum: projectMemberRoleValues })
      .notNull()
      .default("member"),
    addedById: text("added_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("project_members_project_user_idx").on(
      table.projectId,
      table.userId,
    ),
    index("project_members_user_idx").on(table.userId),
  ],
);

export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("task_comments_task_idx").on(table.taskId),
    index("task_comments_project_idx").on(table.projectId),
    index("task_comments_author_idx").on(table.authorId),
    index("task_comments_created_idx").on(table.createdAt),
  ],
);

export const requestComments = sqliteTable(
  "request_comments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requestId: text("request_id")
      .notNull()
      .references(() => clientRequests.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("request_comments_request_idx").on(table.requestId),
    index("request_comments_project_idx").on(table.projectId),
    index("request_comments_author_idx").on(table.authorId),
    index("request_comments_created_idx").on(table.createdAt),
  ],
);

export const notificationReads = sqliteTable(
  "notification_reads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    notificationId: text("notification_id").notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("notification_reads_user_notif_idx").on(
      table.userId,
      table.notificationId,
    ),
    index("notification_reads_user_idx").on(table.userId),
  ],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role", { enum: userRoleValues }).notNull().default("member"),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("invitations_token_idx").on(table.token),
    index("invitations_email_idx").on(table.email),
  ],
);

export const dailyTasks = sqliteTable(
  "daily_tasks",
  {
    id: text("id").primaryKey(),
    // Whose day-plan this item sits on / recipient of admin actions.
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Who created it; differs from ownerId when an admin plans for someone.
    createdById: text("created_by_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // The calendar key — stored at start-of-day in the owner's local TZ.
    plannedDate: integer("planned_date", { mode: "timestamp_ms" }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: taskStatusValues }).notNull().default("todo"),
    priority: text("priority", { enum: priorityValues })
      .notNull()
      .default("medium"),
    kind: text("kind", { enum: dailyTaskKindValues })
      .notNull()
      .default("adhoc"),
    // Null for adhoc; set for project items. SET NULL so deleting a project
    // demotes the planner item rather than erasing the day-plan.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    // Set for both push (new board card) and pull (existing card). SET NULL so
    // deleting either side never destroys the other.
    linkedTaskId: text("linked_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
    // Groups rows fanned out by one admin action so edit/delete can cascade.
    batchId: text("batch_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("daily_tasks_owner_date_idx").on(table.ownerId, table.plannedDate),
    index("daily_tasks_date_idx").on(table.plannedDate),
    index("daily_tasks_linked_task_idx").on(table.linkedTaskId),
    index("daily_tasks_project_idx").on(table.projectId),
    index("daily_tasks_batch_idx").on(table.batchId),
    index("daily_tasks_owner_date_sort_idx").on(
      table.ownerId,
      table.plannedDate,
      table.sortOrder,
    ),
  ],
);

export const notificationToneValues = ["danger", "warning", "default"] as const;

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    // Who receives it. Cascade: deleting the user removes their notifications.
    recipientId: text("recipient_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Who triggered it. Set null so the row survives the actor's deletion;
    // the actor name is denormalized into `body` at write time.
    actorId: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    tone: text("tone", { enum: notificationToneValues })
      .notNull()
      .default("default"),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("notifications_recipient_idx").on(table.recipientId),
    index("notifications_recipient_created_idx").on(
      table.recipientId,
      table.createdAt,
    ),
  ],
);

/**
 * App-wide configuration. Singleton: exactly one row, id = 1 (a CHECK in the
 * migration enforces it). Read by the root layout to brand the whole app — web
 * title, the dynamic system/brand name, one theme accent hex (shades derived in
 * CSS), and R2 keys (under the `branding/` prefix) for a dark/light sidebar logo
 * pair and a square favicon. Null logo/favicon keys mean "use the bundled
 * defaults".
 */
export const systemSettings = sqliteTable("system_settings", {
  id: integer("id").primaryKey(),
  webTitle: text("web_title").notNull().default("Seeder"),
  systemName: text("system_name").notNull().default("Seeder"),
  accentColor: text("accent_color").notNull().default("#10b981"),
  logoDarkKey: text("logo_dark_key"),
  logoLightKey: text("logo_light_key"),
  faviconKey: text("favicon_key"),
  sidebarMarkKey: text("sidebar_mark_key"),
  // Open Graph / link-preview card customization. Null → fall back to the
  // bundled seeder-web defaults (PREVIEW_DEFAULTS in lib/system-settings).
  previewTitle: text("preview_title"),
  previewDescription: text("preview_description"),
  previewImageKey: text("preview_image_key"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type ProjectStatus = (typeof projectStatusValues)[number];
export type RequestStatus = (typeof requestStatusValues)[number];
export type TaskStatus = (typeof taskStatusValues)[number];
export type Priority = (typeof priorityValues)[number];
export type DailyTaskKind = (typeof dailyTaskKindValues)[number];
export type NotificationTone = (typeof notificationToneValues)[number];
export type Notification = typeof notifications.$inferSelect;
export type ActivityEntity = (typeof activityEntityValues)[number];
export type ActivityAction = (typeof activityActionValues)[number];

export type Project = typeof projects.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type Space = typeof spaces.$inferSelect;
export type SpaceMember = typeof spaceMembers.$inferSelect;
export type ClientRequest = typeof clientRequests.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskChecklistItem = typeof taskChecklistItems.$inferSelect;
export type ProjectStatusUpdate = typeof projectStatusUpdates.$inferSelect;
export type ProjectNote = typeof projectNotes.$inferSelect;
export type ProjectActivity = typeof projectActivity.$inferSelect;
export type User = typeof user.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type DailyTask = typeof dailyTasks.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type RequestComment = typeof requestComments.$inferSelect;
export type NotificationRead = typeof notificationReads.$inferSelect;
export type TaskCategory = typeof taskCategories.$inferSelect;
export type TaskStatusRow = typeof taskStatuses.$inferSelect;
export type TaskLabel = typeof taskLabels.$inferSelect;
export type TaskTaskLabel = typeof taskTaskLabels.$inferSelect;
export type SystemSettings = typeof systemSettings.$inferSelect;
export type PersonalAccessToken = typeof personalAccessToken.$inferSelect;

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Daniel Syauqi and Thaqif Rosdi

// Fixed sentinel id for the "Git integration" bot user, inserted in
// migrations/0038_vcs_core.sql. Used as the project_activity.owner_id
// fallback when a commit's author can't be resolved to a real Seeder member
// (project_activity.owner_id is NOT NULL). This user has no `account` row, so
// it can never sign in regardless of role.
export const VCS_BOT_USER_ID = "vcs-bot";

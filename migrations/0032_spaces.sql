-- Spaces group projects. "personal" = one private space per user (only the owner
-- + workspace admins see its projects); "company" = a named, shared space an
-- admin creates whose members get baseline access to all its projects. Every
-- project gains a space_id. Existing projects move into their OWNER's Personal
-- space. space_id is added NULLABLE (SQLite can't ALTER ADD a NOT NULL FK); the
-- app layer guarantees every write sets it. Plain REFERENCES (NO ACTION) — a
-- non-empty company space's deletion is refused in the service, never cascaded.

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX spaces_owner_idx ON spaces(owner_id);
CREATE UNIQUE INDEX spaces_personal_owner_idx ON spaces(owner_id) WHERE kind = 'personal';

CREATE TABLE space_members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  added_by_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE UNIQUE INDEX space_members_space_user_idx ON space_members(space_id, user_id);
CREATE INDEX space_members_user_idx ON space_members(user_id);

-- One Personal space per existing user (even users with no projects get a home).
INSERT INTO spaces (id, kind, name, owner_id, lead_id, created_by, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'personal', 'Personal', u.id, NULL, u.id,
       unixepoch() * 1000, unixepoch() * 1000
FROM "user" u;

-- Add the column (nullable), then move every project into its owner's Personal.
ALTER TABLE projects ADD COLUMN space_id TEXT REFERENCES spaces(id);
UPDATE projects
SET space_id = (
  SELECT s.id FROM spaces s
  WHERE s.kind = 'personal' AND s.owner_id = projects.owner_id
);
CREATE INDEX projects_space_idx ON projects(space_id);

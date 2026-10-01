import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'
import {
  migrateLegacyGardeniaDatabaseFile,
  runGardeniaToAtelierWorktreeMigration
} from './migrations/gardenia-to-atelier'
import { runHistoricalCostBackfill } from './sessions/historical-cost-recompute'
import { SessionStore } from './sessions/store'
import { rebuildSessionTouchedPathsFromMessages } from './sessions/session-changes-cap'

let db: Database.Database | undefined

function tableHasColumn(database: Database.Database, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

/** Ordered list of migrations. Each runs once, tracked in the `migrations` table. */
const MIGRATIONS: Array<{ name: string; sql?: string; run?: (database: Database.Database) => void }> = [
  {
    name: '0001_sessions_and_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_locked_by_user INTEGER NOT NULL DEFAULT 0,
        project_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('terminal', 'claude-code')),
        hostname TEXT,
        group_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_event TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
    `
  },
  {
    // 06-session-organization: tags (free-form, many-to-many via join table),
    // notes (freeform text per session), a real `session_groups` table
    // (group_id on `sessions` previously held an arbitrary caller-chosen
    // string used directly as the display label — now it's a foreign id into
    // this table, with its own name/order/collapsed state), and a
    // `sort_order` column on `sessions` for manual drag-drop ordering within
    // a group (or within the ungrouped/pinned sections).
    name: '0002_tags_notes_groups_ordering',
    sql: `
      ALTER TABLE sessions ADD COLUMN notes TEXT;
      ALTER TABLE sessions ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    // 10a-enrichment-cost-tracking: running per-session dollar total, sourced
    // exclusively from the SDK's own `result` event's `totalCostUsd` (see
    // HarnessEvent's 'result' variant) — persisted so it survives relaunch.
    name: '0003_session_cost_tracking',
    sql: `
      ALTER TABLE sessions ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;
    `
  },
  {
    // 10b-enrichment-full-text-search: an FTS5 virtual table over each
    // message's plain searchable text (see shared/chat-content.ts's
    // `extractSearchableText` — user/assistant plain text only, never raw
    // tool-call JSON or other structured-content rows). NOT an "external
    // content" FTS5 table: rows are inserted/updated/deleted explicitly by
    // `SessionStore` (using `rowid = messages.id`) exactly when a message is
    // written, rather than via SQL triggers mirroring `messages` verbatim —
    // that's the only way to apply `extractSearchableText`'s JS-side
    // filtering (skip system rows, skip structured JSON) before indexing.
    // Used by `SessionStore.searchMessages` for the cross-session content
    // search surfaced in the command palette's "Session" results.
    name: '0004_message_full_text_search',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        tokenize = 'unicode61'
      );
    `
  },
  {
    // fix-bug-triage-jul31 / bug #49: remembers recently-used project paths
    // per host so the New Session modal can offer them again on reopen,
    // instead of NewSessionModal's `isOpen` effect unconditionally wiping
    // `projectPath` back to null every time it opens. Keyed on (host_id,
    // path) so re-using an existing path is an upsert (bumps `used_at`,
    // never duplicates) rather than growing unbounded — pruning to the 10
    // most recent per host happens in SessionStore.recordProjectPathUsage.
    name: '0005_project_path_history',
    sql: `
      CREATE TABLE IF NOT EXISTS project_path_history (
        host_id TEXT NOT NULL,
        path TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (host_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_project_path_history_host_used ON project_path_history(host_id, used_at);
    `
  },
  {
    // fix-no-conversation-found-remote-resume: persisted, cross-relaunch
    // record of whether the underlying harness/CLI has EVER actually
    // confirmed a real conversation for this session id (i.e. its `system`/
    // `init` handshake — HarnessEvent's `session_started` — has actually
    // fired at least once; see SessionStore.markEverConnected). A session
    // created via `harness.start()` with no initial prompt sits in
    // `SessionManager.sessions` looking "live" (`harness.isActive()` is
    // true) but the underlying CLI never emits `session_started` until it
    // actually receives its first real input — so `everConnected` can be
    // `false` even for a session with an open, active harness connection.
    // Verified for real: reconnect()/sendUserMessage() previously called
    // `harness.resume()` (a `--resume <id>` reconnect) unconditionally for
    // ANY session with no currently-active in-memory harness entry,
    // including one that had never gotten this far — the underlying `claude`
    // CLI has no record of a session id it was never actually asked to
    // start, and rejects the resume with "No conversation found with session
    // ID: <id>" (root cause of the recurring "Claude Code process exited
    // with code 255" bug, both locally and on remote/SSH hosts). Defaults to
    // 0 (false) for both new and pre-existing rows — a pre-existing row from
    // before this migration necessarily already has real transcript history
    // (it could only exist by having gone through a real turn under the
    // pre-fix code), so `everConnected` is backfilled to 1 for any session
    // with at least one persisted message, since resuming those is safe and
    // was already working.
    name: '0006_session_ever_connected',
    sql: `
      ALTER TABLE sessions ADD COLUMN ever_connected INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET ever_connected = 1
        WHERE id IN (SELECT DISTINCT session_id FROM messages);
    `
  },
  {
    // restore-mode-and-model-on-resume: persists the session's current SDK
    // permission mode and model/effort selection to SQLite so both survive
    // an app relaunch and are restored when the user resumes a session.
    // `permission_mode` mirrors the in-memory `permissionModes` Map and
    // defaults to 'default' (the SDK's own default) for pre-existing rows.
    // `model_id` and `effort` mirror the in-memory `modelSelections` Map;
    // both are nullable since a session that was never sent a message has
    // no stored model override.
    name: '0007_session_mode_model',
    sql: `
      ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE sessions ADD COLUMN model_id TEXT;
      ALTER TABLE sessions ADD COLUMN effort TEXT;
    `
  },
  {
    // use-worktree: optional isolated git worktree per session. When the
    // user enables "Use worktree" in the New Session modal for a local
    // claude-code session, Atelier creates a git worktree at
    // `<worktreeRoot>/<session-id>` (config, default `~/.atelier/worktrees`) on a new branch
    // `atelier-<session-id-prefix>`, runs Claude Code inside that
    // worktree path instead of the original project path, and removes both
    // the worktree directory and its branch when the session is deleted.
    // Null for sessions that were not created with useWorktree, or for
    // remote/terminal sessions where worktrees are out of scope.
    name: '0008_session_worktree',
    sql: `
      ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
    `
  },
  {
    // fix-app-quit-interrupted-turn-notice: set when Atelier closes or quits
    // while a turn is in flight (`live.busy`); consumed once on the next
    // resume/relaunch transcript load to insert a plain-language system
    // notice (not a raw SDK "process exited" error).
    name: '0009_pending_turn_interrupted_notice',
    sql: `
      ALTER TABLE sessions ADD COLUMN pending_turn_interrupted_notice INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    name: '0010_app_notes',
    sql: `
      CREATE TABLE IF NOT EXISTS app_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_app_notes_sort ON app_notes(sort_order);
    `
  },
  {
    // session-startup-idle: when the user last interacted with a session
    // (select or send). Backfilled from the latest message timestamp, else
    // `created_at`, so existing rows are usable immediately after migrate.
    name: '0011_session_last_active_at',
    run(database) {
      if (!tableHasColumn(database, 'sessions', 'last_active_at')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN last_active_at TEXT;`)
      }
      database.exec(`
        UPDATE sessions SET last_active_at = COALESCE(
          (SELECT MAX(created_at) FROM messages WHERE messages.session_id = sessions.id),
          created_at
        )
        WHERE last_active_at IS NULL;
      `)
    }
  },
  {
    name: '0012_session_linked_daily_task',
    run(database) {
      if (!tableHasColumn(database, 'sessions', 'linked_daily_task_gid')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN linked_daily_task_gid TEXT;`)
      }
      if (!tableHasColumn(database, 'sessions', 'linked_daily_note_date')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN linked_daily_note_date TEXT;`)
      }
    }
  },
  {
    // chat changes cap: persisted rollups of Edit/Write/MultiEdit/NotebookEdit
    // tool calls per session (survives reconnect/relaunch); superseded by 0014.
    name: '0013_session_file_edits',
    sql: `
      CREATE TABLE IF NOT EXISTS session_file_edits (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_session_file_edits_session ON session_file_edits(session_id);
    `
  },
  {
    name: '0014_session_changes_cap_v2',
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS session_touched_paths (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          first_touched_at TEXT NOT NULL,
          last_pending_at TEXT,
          PRIMARY KEY (session_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_session_touched_paths_session ON session_touched_paths(session_id);

        CREATE TABLE IF NOT EXISTS session_cap_commits (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          hash TEXT NOT NULL,
          subject TEXT NOT NULL,
          committed_at TEXT NOT NULL,
          sort_order REAL NOT NULL,
          PRIMARY KEY (session_id, hash)
        );
        CREATE INDEX IF NOT EXISTS idx_session_cap_commits_session ON session_cap_commits(session_id);

        CREATE TABLE IF NOT EXISTS session_git_cursor (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          last_head TEXT,
          baseline_head TEXT
        );

        INSERT OR IGNORE INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
          SELECT session_id, path, updated_at, updated_at FROM session_file_edits;

        DROP TABLE IF EXISTS session_file_edits;
      `)
      const store = new SessionStore(database)
      const sessions = database
        .prepare('SELECT id, project_path, worktree_path FROM sessions')
        .all() as Array<{ id: string; project_path: string; worktree_path: string | null }>
      for (const session of sessions) {
        const workspace = session.worktree_path ?? session.project_path
        rebuildSessionTouchedPathsFromMessages(store, session.id, workspace)
      }
    }
  },
  {
    name: '0015_weekly_plan_drafts',
    sql: `
      CREATE TABLE IF NOT EXISTS weekly_plan_drafts (
        iso_week TEXT PRIMARY KEY,
        step INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    name: '0016_session_profile_id',
    run(database) {
      if (!tableHasColumn(database, 'sessions', 'profile_id')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN profile_id TEXT;`)
      }
    }
  },
  {
    // Chat response bookmarks: session-scoped links and files promoted into
    // the changes cap. The composite unique key makes bookmarking idempotent,
    // while the foreign key removes bookmarks with their owning session.
    name: '0017_session_bookmarks',
    sql: `
      CREATE TABLE IF NOT EXISTS session_bookmarks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'link')),
        target TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, kind, target)
      );
      CREATE INDEX IF NOT EXISTS idx_session_bookmarks_session_created
        ON session_bookmarks(session_id, created_at DESC);
    `
  },
  {
    // Sidebar bookmarks: app-wide links, unrelated to any session (unlike
    // session_bookmarks above). URL is unique so re-adding or dropping the
    // same link twice is a no-op rather than a duplicate row.
    name: '0018_app_bookmarks',
    sql: `
      CREATE TABLE IF NOT EXISTS app_bookmarks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_app_bookmarks_sort ON app_bookmarks(sort_order);
    `
  },
  {
    // remember-session-tab: the workspace tab a session was last parked on, so
    // selecting it again (including after a relaunch) restores that tab rather
    // than always snapping back to Chat.
    name: '0019_session_active_tab',
    run(database) {
      if (!tableHasColumn(database, 'sessions', 'active_tab')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN active_tab TEXT NOT NULL DEFAULT 'chat';`)
      }
    }
  },
  {
    // /clear (SDK conversation_reset): Atelier's sessions.id stays stable for
    // the sidebar row, but the CLI conversation id can change. Persist that
    // resume id separately so a later reconnect does not --resume the wiped
    // transcript.
    name: '0020_session_sdk_session_id',
    run(database) {
      if (!tableHasColumn(database, 'sessions', 'sdk_session_id')) {
        database.exec(`ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;`)
      }
      database.exec(`UPDATE sessions SET sdk_session_id = id WHERE sdk_session_id IS NULL;`)
    }
  },
  {
    // Widen the mode CHECK constraint to include 'cortana'. SQLite does not
    // support ALTER COLUMN, so we recreate the sessions table with the full
    // column list (verified against PRAGMA table_info after migration 0020)
    // and the updated constraint, then swap it in.
    name: '0021_session_mode_cortana',
    run(database) {
      database.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_locked_by_user INTEGER NOT NULL DEFAULT 0,
          project_path TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('terminal', 'claude-code', 'cortana')),
          hostname TEXT,
          group_id TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          color TEXT,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          deleted_at TEXT,
          notes TEXT,
          sort_order REAL NOT NULL DEFAULT 0,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          ever_connected INTEGER NOT NULL DEFAULT 0,
          permission_mode TEXT NOT NULL DEFAULT 'default',
          model_id TEXT,
          effort TEXT,
          worktree_path TEXT,
          pending_turn_interrupted_notice INTEGER NOT NULL DEFAULT 0,
          last_active_at TEXT,
          linked_daily_task_gid TEXT,
          linked_daily_note_date TEXT,
          profile_id TEXT,
          active_tab TEXT NOT NULL DEFAULT 'chat',
          sdk_session_id TEXT
        );
        INSERT INTO sessions_new SELECT
          id, name, name_locked_by_user, project_path, mode, hostname, group_id,
          pinned, color, created_at, closed_at, deleted_at, notes, sort_order,
          total_cost_usd, ever_connected, permission_mode, model_id, effort,
          worktree_path, pending_turn_interrupted_notice, last_active_at,
          linked_daily_task_gid, linked_daily_note_date, profile_id, active_tab,
          sdk_session_id
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
      `)
    }
  },
  {
    name: '0022_session_mode_minion',
    run(database) {
      database.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_locked_by_user INTEGER NOT NULL DEFAULT 0,
          project_path TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('terminal', 'claude-code', 'cortana', 'minion')),
          hostname TEXT,
          group_id TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          color TEXT,
          created_at TEXT NOT NULL,
          closed_at TEXT,
          deleted_at TEXT,
          notes TEXT,
          sort_order REAL NOT NULL DEFAULT 0,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          ever_connected INTEGER NOT NULL DEFAULT 0,
          permission_mode TEXT NOT NULL DEFAULT 'default',
          model_id TEXT,
          effort TEXT,
          worktree_path TEXT,
          pending_turn_interrupted_notice INTEGER NOT NULL DEFAULT 0,
          last_active_at TEXT,
          linked_daily_task_gid TEXT,
          linked_daily_note_date TEXT,
          profile_id TEXT,
          active_tab TEXT NOT NULL DEFAULT 'chat',
          sdk_session_id TEXT
        );
        INSERT INTO sessions_new SELECT
          id, name, name_locked_by_user, project_path, mode, hostname, group_id,
          pinned, color, created_at, closed_at, deleted_at, notes, sort_order,
          total_cost_usd, ever_connected, permission_mode, model_id, effort,
          worktree_path, pending_turn_interrupted_notice, last_active_at,
          linked_daily_task_gid, linked_daily_note_date, profile_id, active_tab,
          sdk_session_id
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
      `)
    }
  }
]

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    database.prepare('SELECT name FROM migrations').all().map((row) => (row as { name: string }).name)
  )

  const insertMigration = database.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    const runOne = database.transaction(() => {
      if (migration.run) migration.run(database)
      else if (migration.sql) database.exec(migration.sql)
      else throw new Error(`migration ${migration.name} has no sql or run`)
      insertMigration.run(migration.name, new Date().toISOString())
    })
    runOne()
    logger.info('database migration applied', { name: migration.name })
  }
}

/**
 * Opens (creating if needed) the app's SQLite database file under the
 * user-data dir, and runs any pending migrations (sessions/messages schema
 * added in 02-session-lifecycle).
 */
export function openDatabase(): Database.Database {
  if (db) return db

  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  migrateLegacyGardeniaDatabaseFile(dataDir)
  const dbPath = join(dataDir, 'atelier.sqlite')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  runGardeniaToAtelierWorktreeMigration(db)
  // fix-session-cost-historical-backfill (one-time, tracked as
  // '0006_historical_cost_recompute_from_jsonl' in the same `migrations`
  // table `runMigrations` uses — not a plain-SQL entry in MIGRATIONS above
  // because it needs real file/SSH I/O): `0003_session_cost_tracking`'s
  // `total_cost_usd` was populated by SessionManager additively summing the
  // SDK's ALREADY-cumulative `result.total_cost_usd` every turn (fixed
  // going-forward in fix-session-cost-total-overcounted, not retroactively).
  // Sessions that compounded before that fix landed are stuck with a
  // permanently inflated `total_cost_usd` (confirmed for real: session
  // f93a2566-846d-4e89-b23b-b7ca7016d493 showing $365.24 against a real
  // cross-session total of ~$293) with no durable record of the true figure
  // anywhere in THIS db (`result` events only ever reach it via a bare
  // `SessionStore.addCost` UPDATE, and no persisted `messages.raw_event`
  // carries per-turn usage/token counts either — spot-checked: zero rows
  // match `raw_event LIKE '%total_cost%'`).
  //
  // BUT the SDK's own on-disk JSONL transcript for the session (written by
  // the `claude` CLI, keyed by the exact same session id Atelier uses as
  // `sessions.id` — see `ClaudeAgentSdkHarness.launch`'s `sessionId`/`resume`
  // option — at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`,
  // locally or on the session's remote host) DOES durably retain every
  // turn's raw `usage` untouched by this bug. Verified for real against the
  // actual corrupted session's transcript on its remote host
  // (qingqin-go.devpod-us-or): recomputing cost from that transcript's usage
  // (deduping repeated streaming `assistant` JSONL lines that share
  // identical cumulative usage per API call, per known per-model rates)
  // gives $27.13 — matching this same spec's own note that the session's
  // total "climbed from ~$27" before compounding to $365.24. So the true
  // historical cost IS recoverable — just not from this DB.
  //
  // `runHistoricalCostBackfill` (see `historical-cost-recompute.ts`)
  // recomputes every already-corrupted session's `total_cost_usd` from its
  // JSONL transcript where one can still be found, and falls back to
  // resetting to 0 — rather than leaving a confidently-wrong number in
  // place — only for sessions whose transcript is genuinely gone. Runs at
  // most once ever per DB file (gated on `migrations`, synchronous to match
  // better-sqlite3's sync API).
  runHistoricalCostBackfill(db)
  logger.info('database opened', { dbPath })
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = undefined
  }
}

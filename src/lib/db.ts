import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// One SQLite file. Kept on globalThis so dev reloads and every route bundle
// share the same connection.
const g = globalThis as unknown as { __deployerDb?: Database.Database; __deployerDbPath?: string }

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE admins (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    totp_secret_enc TEXT,
    totp_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    second_factor INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX login_attempts_key ON login_attempts(key, at);
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL DEFAULT 'deployer',
    host_key TEXT NOT NULL DEFAULT '',
    public_ip TEXT NOT NULL DEFAULT '',
    max_clubs INTEGER NOT NULL DEFAULT 10,
    accepts_new INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE clubs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    server_id INTEGER NOT NULL REFERENCES servers(id),
    status TEXT NOT NULL,
    image TEXT NOT NULL,
    modules TEXT NOT NULL DEFAULT '[]',
    custom_domains TEXT NOT NULL DEFAULT '[]',
    secrets_enc TEXT NOT NULL DEFAULT '',
    extra_env TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
    memory_mb INTEGER NOT NULL DEFAULT 700,
    owner_email TEXT NOT NULL DEFAULT '',
    owner_name TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE operations (
    id INTEGER PRIMARY KEY,
    club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
    club_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    batch TEXT NOT NULL DEFAULT '',
    payload_enc TEXT NOT NULL DEFAULT '',
    log TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX operations_club ON operations(club_id, id);
  CREATE INDEX operations_status ON operations(status, id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: AI assistant. One row per site allowed to use it (deployer sites have
  // club_id; outside sites don't). Keys are stored hashed.
  `
  CREATE TABLE assist_sites (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    club_id INTEGER UNIQUE REFERENCES clubs(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    daily_limit INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE assist_usage (
    site_id INTEGER NOT NULL REFERENCES assist_sites(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    feature TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    gen_tokens INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day, feature)
  );
  `,
  // The last brief used to build each site's pages, so "Build again" starts from it.
  `
  CREATE TABLE site_briefs (
    club_id INTEGER PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
    brief TEXT NOT NULL,
    skeleton TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  `,
  // 4: versions. Pinned sites are skipped by rollouts, test sites get a
  // rollout first, and every version a site ran is kept for "Roll back".
  `
  ALTER TABLE clubs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clubs ADD COLUMN test_site INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE club_versions (
    id INTEGER PRIMARY KEY,
    club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    image TEXT NOT NULL,
    by TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  );
  CREATE INDEX club_versions_club ON club_versions(club_id, id);
  INSERT INTO club_versions (club_id, image, by, at) SELECT id, image, '', updated_at FROM clubs;
  `,
  // 5: monitoring. Sites the deployer watches: its own (club_id set) and
  // sites hosted elsewhere (just a name and a web address).
  `
  CREATE TABLE watched_sites (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    club_id INTEGER UNIQUE REFERENCES clubs(id) ON DELETE CASCADE,
    paused INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unknown',
    fails INTEGER NOT NULL DEFAULT 0,
    status_since TEXT,
    last_checked_at TEXT,
    last_ms INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    has_health INTEGER NOT NULL DEFAULT 0,
    version TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    cert_expires_at TEXT,
    cert_checked_at TEXT,
    cert_alert_level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE site_checks (
    id INTEGER PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES watched_sites(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    ms INTEGER,
    error TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX site_checks_site ON site_checks(site_id, id);
  CREATE INDEX site_checks_at ON site_checks(at);
  `,
  // 6: off-site backups. Each site's schedule; one row per backup in the
  // bucket (its file list kept here, gzipped, for flushing unused files);
  // which uploaded files and images are already in the bucket.
  `
  ALTER TABLE clubs ADD COLUMN backup_frequent_hours INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clubs ADD COLUMN backup_frequent_keep_days INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE clubs ADD COLUMN backup_daily INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE clubs ADD COLUMN backup_daily_hour INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE clubs ADD COLUMN backup_daily_keep_days INTEGER NOT NULL DEFAULT 30;
  ALTER TABLE clubs ADD COLUMN backup_alert TEXT NOT NULL DEFAULT '';
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    ref TEXT NOT NULL UNIQUE,
    ns TEXT NOT NULL,
    club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
    club_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    image_digest TEXT NOT NULL DEFAULT '',
    db_bytes INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    file_bytes INTEGER NOT NULL DEFAULT 0,
    new_bytes INTEGER NOT NULL DEFAULT 0,
    files_gz BLOB,
    keep_until TEXT,
    note TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX backups_ns ON backups(ns, started_at);
  CREATE INDEX backups_club ON backups(club_id, started_at);
  CREATE TABLE backup_blobs (
    ns TEXT NOT NULL,
    sha TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ns, sha)
  );
  CREATE TABLE backup_images (
    digest TEXT PRIMARY KEY,
    image TEXT NOT NULL,
    stored INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 7: user numbers on Monitoring. The latest counts on the site's row, one
  // row per site per day for growth, and the key for sites hosted elsewhere.
  `
  ALTER TABLE watched_sites ADD COLUMN stats_key_enc TEXT NOT NULL DEFAULT '';
  ALTER TABLE watched_sites ADD COLUMN stats_checked_at TEXT;
  ALTER TABLE watched_sites ADD COLUMN stats_error TEXT NOT NULL DEFAULT '';
  ALTER TABLE watched_sites ADD COLUMN members INTEGER;
  ALTER TABLE watched_sites ADD COLUMN staff INTEGER;
  ALTER TABLE watched_sites ADD COLUMN members_active INTEGER;
  ALTER TABLE watched_sites ADD COLUMN members_new INTEGER;
  CREATE TABLE site_stats (
    site_id INTEGER NOT NULL REFERENCES watched_sites(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    members INTEGER NOT NULL,
    staff INTEGER NOT NULL,
    members_active INTEGER NOT NULL,
    members_new INTEGER NOT NULL,
    PRIMARY KEY (site_id, day)
  );
  `,
  // 8: apps. A site is either Avrosphere (a club) or an app built from a
  // GitHub repo + branch (kind = 'app'). Each build of an app is a row in
  // app_builds; the version list notes the commit message.
  `
  ALTER TABLE clubs ADD COLUMN kind TEXT NOT NULL DEFAULT 'avrosphere';
  ALTER TABLE clubs ADD COLUMN app_repo TEXT NOT NULL DEFAULT '';
  ALTER TABLE clubs ADD COLUMN app_branch TEXT NOT NULL DEFAULT '';
  ALTER TABLE clubs ADD COLUMN app_dockerfile TEXT NOT NULL DEFAULT 'Dockerfile';
  ALTER TABLE clubs ADD COLUMN app_port INTEGER NOT NULL DEFAULT 3000;
  ALTER TABLE clubs ADD COLUMN app_health_path TEXT NOT NULL DEFAULT '/';
  ALTER TABLE clubs ADD COLUMN app_auto_deploy INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE club_versions ADD COLUMN note TEXT NOT NULL DEFAULT '';
  ALTER TABLE watched_sites ADD COLUMN health_path TEXT NOT NULL DEFAULT '';
  CREATE TABLE app_builds (
    id INTEGER PRIMARY KEY,
    club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    sha TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    dockerfile TEXT NOT NULL DEFAULT 'Dockerfile',
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    request_id TEXT NOT NULL,
    run_id INTEGER,
    run_url TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX app_builds_club ON app_builds(club_id, id);
  CREATE INDEX app_builds_status ON app_builds(status);
  `,
  // 9: costs. One row per fetch from AWS (Cost Explorer + Lightsail plans),
  // the numbers kept as JSON in US$ with the A$ rate used.
  `
  CREATE TABLE cost_snapshots (
    id INTEGER PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX cost_snapshots_at ON cost_snapshots(ok, fetched_at);
  `,
  // 10: people and access. Each admin has a role (owner, operator, viewer)
  // and, below owner, either every site or the sites in admin_sites. An
  // invited person has invite_hash set until they pick a password.
  // audit_log records sign-ins, access and settings changes and log views.
  `
  ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner';
  ALTER TABLE admins ADD COLUMN all_sites INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE admins ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE admins ADD COLUMN invite_hash TEXT;
  ALTER TABLE admins ADD COLUMN invite_expires_at TEXT;
  ALTER TABLE admins ADD COLUMN invited_by TEXT NOT NULL DEFAULT '';
  ALTER TABLE admins ADD COLUMN last_sign_in_at TEXT;
  CREATE UNIQUE INDEX admins_invite ON admins(invite_hash);
  CREATE TABLE admin_sites (
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_id, club_id)
  );
  CREATE INDEX admin_sites_club ON admin_sites(club_id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor_id INTEGER,
    actor_email TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    club_id INTEGER,
    club_name TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_log_at ON audit_log(at);
  CREATE INDEX audit_log_view ON audit_log(actor_id, action, club_id, at);
  `,
  // 11: projects and PostgreSQL services. A project groups services (sites,
  // apps, databases) on one server, on their own network. Every existing site
  // gets a project of its own with the same name. service_links says which
  // databases an app gets the variables of; admin_projects gives a person
  // every service in a project, now and later.
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    server_id INTEGER NOT NULL REFERENCES servers(id),
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  ALTER TABLE clubs ADD COLUMN project_id INTEGER REFERENCES projects(id);
  ALTER TABLE clubs ADD COLUMN project_synced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clubs ADD COLUMN app_predeploy TEXT NOT NULL DEFAULT '';
  ALTER TABLE clubs ADD COLUMN pg_quota_mb INTEGER NOT NULL DEFAULT 5120;
  ALTER TABLE clubs ADD COLUMN pg_size_bytes INTEGER;
  ALTER TABLE clubs ADD COLUMN pg_connections INTEGER;
  ALTER TABLE clubs ADD COLUMN pg_max_connections INTEGER;
  ALTER TABLE clubs ADD COLUMN pg_checked_at TEXT;
  ALTER TABLE clubs ADD COLUMN pg_read_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE clubs ADD COLUMN pg_alert_level INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE servers ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX clubs_project ON clubs(project_id);
  CREATE TABLE service_links (
    app_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    db_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    prefix TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (app_id, db_id)
  );
  CREATE INDEX service_links_db ON service_links(db_id);
  CREATE TABLE admin_projects (
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_id, project_id)
  );
  CREATE INDEX admin_projects_project ON admin_projects(project_id);
  INSERT INTO projects (name, display_name, server_id, description, created_by, created_at)
    SELECT name, display_name, server_id, '', 'migration', created_at FROM clubs ORDER BY id;
  UPDATE clubs SET project_id = (SELECT p.id FROM projects p WHERE p.name = clubs.name);
  `,
  // 12: apps from a ready-made image (Docker Hub and other registries) instead of a
  // GitHub build, and apps with no web address (only reachable inside their project).
  `
  ALTER TABLE clubs ADD COLUMN app_image_ref TEXT NOT NULL DEFAULT '';
  ALTER TABLE clubs ADD COLUMN app_public INTEGER NOT NULL DEFAULT 1;
  `,
  // 13: servers the deployer makes in Lightsail itself. A managed server has
  // its Lightsail name; purpose 'apps' keeps Avrosphere sites off small ones.
  // server_jobs is one row per create or delete, with its progress log;
  // server_snapshots are the last copies of deleted servers, kept a while.
  `
  ALTER TABLE servers ADD COLUMN lightsail_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE servers ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sites';
  ALTER TABLE servers ADD COLUMN bundle_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE servers ADD COLUMN price_usd REAL NOT NULL DEFAULT 0;
  CREATE TABLE server_jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    lightsail_name TEXT NOT NULL,
    bundle_id TEXT NOT NULL DEFAULT '',
    ram_gb REAL NOT NULL DEFAULT 0,
    price_usd REAL NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT 'sites',
    max_clubs INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL,
    step TEXT NOT NULL DEFAULT '',
    log TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL DEFAULT '',
    ips TEXT NOT NULL DEFAULT '[]',
    static_ip_name TEXT NOT NULL DEFAULT '',
    static_ip TEXT NOT NULL DEFAULT '',
    host_key TEXT NOT NULL DEFAULT '',
    snapshot_name TEXT NOT NULL DEFAULT '',
    server_id INTEGER,
    deadline TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX server_jobs_status ON server_jobs(status, id);
  CREATE TABLE server_snapshots (
    id INTEGER PRIMARY KEY,
    server_name TEXT NOT NULL,
    snapshot_name TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    delete_after TEXT NOT NULL,
    deleted_at TEXT
  );
  `,
  // 14: labels on watched sites (prod, non-prod…). Monitoring shows one table
  // per label, in the labels' order; a site can have several labels.
  `
  CREATE TABLE monitor_labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT 'grey',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE watched_site_labels (
    site_id INTEGER NOT NULL REFERENCES watched_sites(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES monitor_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (site_id, label_id)
  );
  CREATE INDEX watched_site_labels_label ON watched_site_labels(label_id);
  `,
  // 15: the deployer stopped assuming Avrotech (generic defaults in
  // lib/settings.ts). An install that already has people keeps exactly what it
  // had: the old defaults are written in as settings, unless already set.
  // A fresh install (no one in admins yet) gets the generic defaults.
  `
  INSERT OR IGNORE INTO settings (key, value)
  SELECT k, v FROM (
    SELECT 'brandName' AS k, 'Deployer' AS v
    UNION ALL SELECT 'brandTagline', 'Avrosphere by Avrotech'
    UNION ALL SELECT 'brandLogoUrl', '/brand/avrotech-logo.png'
    UNION ALL SELECT 'locale', 'en-AU'
    UNION ALL SELECT 'extraReservedNames', 'avro avrotech avrosphere'
    UNION ALL SELECT 'baseDomain', 'avro.site'
    UNION ALL SELECT 'defaultTimezone', 'Australia/Sydney'
    UNION ALL SELECT 'githubOwner', 'avrotech-com-au'
    UNION ALL SELECT 'githubBuildRepo', 'avrotech-com-au/avrosphere-self-service'
    UNION ALL SELECT 'backupRegion', 'ap-southeast-2'
    UNION ALL SELECT 'costRegion', 'ap-southeast-2'
    UNION ALL SELECT 'provisionRegion', 'ap-southeast-2'
    UNION ALL SELECT 'provisionZone', 'ap-southeast-2a'
  )
  WHERE EXISTS (SELECT 1 FROM admins);
  `,
  // 16: Avrosphere sites and AWS became plugins (src/plugins). An install that
  // is already in use keeps both on; a fresh one starts with none.
  `
  INSERT OR IGNORE INTO settings (key, value)
  SELECT 'plugins', 'avrosphere aws'
  WHERE EXISTS (SELECT 1 FROM admins) OR EXISTS (SELECT 1 FROM clubs);
  `,
  // 17: the AWS plugin shows money in a currency chosen in Settings (US$ by
  // default). The budget and typed rate lose "Aud" from their names, and an
  // install already in use keeps showing A$.
  `
  UPDATE settings SET key = 'costBudget' WHERE key = 'costBudgetAud';
  UPDATE settings SET key = 'costRate' WHERE key = 'costAudRate';
  INSERT OR IGNORE INTO settings (key, value)
  SELECT 'costCurrency', 'AUD'
  WHERE EXISTS (SELECT 1 FROM admins) OR EXISTS (SELECT 1 FROM clubs);
  `,  // 18: S3 storage services (MinIO, kind 'minio'). A storage keeps its buckets
  // (and their latest numbers) on its row; its size and quota use the pg_* columns
  // databases use. An app's link to a storage names the bucket it gets as S3_BUCKET.
  `
  ALTER TABLE clubs ADD COLUMN s3_buckets TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE service_links ADD COLUMN bucket TEXT NOT NULL DEFAULT '';
  `,
]

export function dataDir(): string {
  return path.resolve(process.env.DEPLOYER_DATA_DIR || './data')
}

export function db(): Database.Database {
  const file = process.env.DEPLOYER_DB_FILE || path.join(dataDir(), 'deployer.sqlite')
  if (g.__deployerDb && g.__deployerDbPath === file) return g.__deployerDb
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const conn = new Database(file)
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('busy_timeout = 5000')
  const version = conn.pragma('user_version', { simple: true }) as number
  for (let i = version; i < MIGRATIONS.length; i++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[i])
      conn.pragma(`user_version = ${i + 1}`)
    })()
  }
  g.__deployerDb = conn
  g.__deployerDbPath = file
  return conn
}

/** Tests only: drop the cached connection so the next db() opens a fresh one. */
export function resetDbForTests() {
  g.__deployerDb?.close()
  g.__deployerDb = undefined
  g.__deployerDbPath = undefined
}

export const now = () => new Date().toISOString()

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Tracker, initData } from './tracker.mjs';
import { atomicWrite, atomicWriteJSON, inside, localPath, readBytes, readJSON, sha256 } from './files.mjs';
import { validateSchema } from './validation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_ITEMS = ['profile.json', 'policy.json', 'profile.md', 'intake.md', 'resumes', 'materials', 'reports'];
const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;

function requireSafeTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Backup refuses symbolic link: ${path}`);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) requireSafeTree(join(path, entry));
}

function copyTree(source, destination) {
  requireSafeTree(source);
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(source)) copyTree(join(source, entry), join(destination, entry));
  } else copyFileSync(source, destination);
}

function inventory(root, path = root) {
  const rows = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Backup contains symbolic link: ${full}`);
    if (stat.isDirectory()) rows.push(...inventory(root, full));
    else rows.push({ path: relative(root, full).replaceAll('\\', '/'), bytes: stat.size, sha256: sha256(readBytes(full, { maxBytes: Number.MAX_SAFE_INTEGER })) });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function quoteSQLite(path) { return `'${String(path).replaceAll("'", "''")}'`; }

function invalidateAuthorization(directory, reason) {
  const dir = resolve(directory);
  const store = new Tracker(dir);
  try {
    const profilePath = localPath(dir, 'profile.json');
    const profileBytes = readBytes(profilePath, { base: dir });
    const profile = JSON.parse(profileBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (profile.confirmed_at !== null) {
      profile.confirmed_at = null;
      validateSchema('profile', profile);
      store.writeManagedJSON('profile.json', profile, { expectedSha256: sha256(profileBytes), eventKind: 'authorization_invalidated', eventPayload: { reason } });
    }
    const policyPath = localPath(dir, 'policy.json');
    const policyBytes = readBytes(policyPath, { base: dir });
    const policy = JSON.parse(policyBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (policy.mode !== 'review_each' || policy.auto !== null) {
      policy.mode = 'review_each';
      policy.auto = null;
      validateSchema('policy', policy);
      store.writeManagedJSON('policy.json', policy, { expectedSha256: sha256(policyBytes), eventKind: 'authorization_invalidated', eventPayload: { reason } });
    }
  } finally { store.close(); }
}

function validateDatabaseSnapshot(root) {
  validateSchema('profile', readJSON(join(root, 'profile.json')));
  validateSchema('policy', readJSON(join(root, 'policy.json')));
  const store = new DatabaseSync(join(root, 'history.sqlite'), { readOnly: true });
  try {
    const database = store.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    const foreignKeys = store.prepare('PRAGMA foreign_key_check').all();
    if (database.length !== 1 || database[0] !== 'ok' || foreignKeys.length) throw new Error('Backup database failed integrity check');
    if (store.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('Backup database schema is not v2');
    if (store.prepare('SELECT COUNT(*) AS count FROM pending_file_writes').get().count) throw new Error('Backup contains pending managed file writes');
    for (const name of ['profile.json', 'policy.json']) {
      const tracked = store.prepare('SELECT sha256 FROM file_revisions WHERE name=?').get(name);
      const actual = sha256(readBytes(join(root, name), { maxBytes: Number.MAX_SAFE_INTEGER }));
      if (!tracked || tracked.sha256 !== actual) throw new Error(`Backup ${name} does not match its database revision`);
    }
  } finally { store.close(); }
}

function quarantineData(directory, destination) {
  const dir = resolve(directory);
  const target = resolve(destination);
  if (inside(dir, target) || inside(target, dir)) throw new Error('Quarantine directory must be separate from live data');
  if (existsSync(target)) throw new Error('Quarantine destination already exists');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of [...BACKUP_ITEMS, 'history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm']) {
    const source = localPath(dir, name);
    if (existsSync(source)) copyTree(source, join(target, name));
  }
  const manifest = { schema_version: 'quarantine-1', created_at: new Date().toISOString(), source_name: basename(dir), files: inventory(target) };
  atomicWriteJSON(join(target, 'quarantine-manifest.json'), manifest, { base: target });
  return { directory: target, files: manifest.files.length, restorable_only_by_manual_recovery: true };
}

export function backupData(directory, destination) {
  const dir = resolve(directory);
  const target = resolve(destination);
  if (inside(dir, target) || inside(target, dir)) throw new Error('Backup directory must be separate from the live data directory');
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Backup destination cannot be a symbolic link');
  if (existsSync(target) && readdirSync(target).length) throw new Error('Backup destination must be empty');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const store = new Tracker(dir);
  try {
    const check = store.integrity();
    if (!check.database_ok || check.foreign_key_violations.length || check.pending_file_writes.length ||
        Object.values(check.files).some(file => !file.valid || !file.tracked_sha256_matches)) {
      throw new Error('Refusing to back up invalid data; run doctor and repair first');
    }
    store.db.exec('PRAGMA wal_checkpoint(FULL)');
    store.db.exec(`VACUUM INTO ${quoteSQLite(join(target, 'history.sqlite'))}`);
  } finally { store.close(); }
  for (const name of BACKUP_ITEMS) {
    const source = localPath(dir, name);
    if (existsSync(source)) copyTree(source, join(target, name));
  }
  validateDatabaseSnapshot(target);
  const manifest = { schema_version: 1, created_at: new Date().toISOString(), source_name: basename(dir), files: inventory(target) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (manifestBytes.length > MAX_BACKUP_MANIFEST_BYTES) throw new Error(`Backup manifest exceeds the ${MAX_BACKUP_MANIFEST_BYTES} byte limit`);
  atomicWrite(join(target, 'backup-manifest.json'), manifestBytes, { base: target });
  verifyBackupContents(target);
  return { directory: target, files: manifest.files.length, manifest: join(target, 'backup-manifest.json') };
}

function verifyBackupContents(source) {
  const root = resolve(source);
  if (lstatSync(root).isSymbolicLink()) throw new Error('Backup root cannot be a symbolic link');
  const manifest = readJSON(join(root, 'backup-manifest.json'), { maxBytes: MAX_BACKUP_MANIFEST_BYTES });
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported backup manifest');
  const expectedPaths = new Set();
  for (const expected of manifest.files) {
    if (!expected || typeof expected.path !== 'string' || expectedPaths.has(expected.path)) throw new Error('Backup manifest contains an invalid or duplicate path');
    expectedPaths.add(expected.path);
    const path = resolve(root, expected.path);
    if (!inside(root, path) || !existsSync(path)) throw new Error(`Backup file missing: ${expected.path}`);
    const bytes = readBytes(path, { maxBytes: Number.MAX_SAFE_INTEGER });
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Backup file failed verification: ${expected.path}`);
  }
  const actual = inventory(root).filter(row => row.path !== 'backup-manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)))) {
    throw new Error('Backup contents do not exactly match the manifest');
  }
  validateDatabaseSnapshot(root);
  return manifest;
}

export function verifyBackup(source) {
  const manifest = verifyBackupContents(source);
  return { valid: true, files: manifest.files.length, created_at: manifest.created_at };
}

export function restoreData(directory, source, confirmation) {
  if (confirmation !== 'RESTORE VERIFIED JOBHUNT BACKUP') throw new Error('Exact restore confirmation required');
  const dir = resolve(directory);
  const backup = resolve(source);
  const manifest = verifyBackupContents(backup);
  const safety = `${dir}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const staging = `${dir}.restore-staging-${randomUUID()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const name of [...BACKUP_ITEMS, 'history.sqlite']) {
      const input = join(backup, name);
      if (existsSync(input)) copyTree(input, join(staging, name));
    }
    if (JSON.stringify(inventory(staging)) !== JSON.stringify([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)))) {
      throw new Error('Staged restore contents changed after backup verification');
    }
    validateDatabaseSnapshot(staging);
    invalidateAuthorization(staging, 'restore_replaced_local_ledger');
    validateDatabaseSnapshot(staging);
    quarantineData(dir, safety);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of [...BACKUP_ITEMS, 'history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm']) {
        const target = localPath(dir, name);
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      }
      for (const name of [...BACKUP_ITEMS, 'history.sqlite']) {
        const input = join(staging, name);
        if (existsSync(input)) copyTree(input, join(dir, name));
      }
      const ignore = localPath(dir, '.gitignore');
      if (!existsSync(ignore)) atomicWrite(ignore, '*\n', { base: dir });
      validateDatabaseSnapshot(dir);
    } catch (error) {
      try {
        for (const name of [...BACKUP_ITEMS, 'history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm']) {
          const target = localPath(dir, name);
          if (existsSync(target)) rmSync(target, { recursive: true, force: true });
          const input = join(safety, name);
          if (existsSync(input)) copyTree(input, target);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Restore and automatic rollback failed; quarantine preserved at ${safety}`);
      }
      throw error;
    }
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); }
  return { restored: true, source: backup, automatic_quarantine: safety };
}

export function privacyMap(directory) {
  const dir = resolve(directory);
  return {
    data: dir,
    authoritative: { candidate_facts: localPath(dir, 'profile.json'), history: localPath(dir, 'history.sqlite'), policy: localPath(dir, 'policy.json') },
    derived_or_copied: { resumes: localPath(dir, 'resumes'), materials: localPath(dir, 'materials'), reports: localPath(dir, 'reports') },
    notes: ['profile_saved events in schema v2 store changed field names, not complete profile snapshots', 'older schema v1 events may contain full profile snapshots', 'data is local and not encrypted']
  };
}

function setPath(object, dotted, replacement) {
  const parts = dotted.split('.').filter(Boolean);
  if (!parts.length) throw new Error('Redaction fields must be dotted profile paths');
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current || typeof current !== 'object' || !(part in current)) throw new Error(`Unknown profile field: ${dotted}`);
    current = current[part];
  }
  const leaf = parts.at(-1);
  if (!current || typeof current !== 'object' || !(leaf in current)) throw new Error(`Unknown profile field: ${dotted}`);
  current[leaf] = replacement;
}

function redactLegacy(value) {
  if (Array.isArray(value)) return value.map(redactLegacy);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = ['previous', 'next', 'user_authorization'].includes(key) ? '[REDACTED]' : redactLegacy(item);
  return output;
}

export function redactData(directory, input) {
  if (input.confirmation !== 'REDACT LOCAL JOBHUNT PII') throw new Error('Exact redaction confirmation required');
  if (!Array.isArray(input.fields) || !input.fields.length || !input.fields.every(field => typeof field === 'string')) throw new Error('Redaction requires profile fields');
  const dir = resolve(directory);
  const store = new Tracker(dir);
  try {
    const profilePath = localPath(dir, 'profile.json');
    const bytes = readBytes(profilePath, { base: dir });
    const profile = JSON.parse(bytes.toString('utf8'));
    for (const field of input.fields) setPath(profile, field, null);
    profile.confirmed_at = null;
    validateSchema('profile', profile);
    store.writeManagedJSON('profile.json', profile, { expectedSha256: sha256(bytes), eventKind: 'privacy_redacted', eventPayload: { fields: input.fields } });
    if (input.redact_legacy_history !== false) {
      const rows = store.db.prepare('SELECT id,payload FROM events').all();
      const update = store.db.prepare('UPDATE events SET payload=? WHERE id=?');
      store.transaction(() => { for (const row of rows) update.run(JSON.stringify(redactLegacy(JSON.parse(row.payload))), row.id); });
    }
    return { redacted: input.fields, confirmation_required_for_search: true, legacy_history_redacted: input.redact_legacy_history !== false };
  } finally { store.close(); }
}

export function purgeData(directory, input) {
  if (input.confirmation !== 'PURGE LOCAL JOBHUNT DATA') throw new Error('Exact purge confirmation required');
  if (typeof input.backup_directory !== 'string' || !input.backup_directory) throw new Error('Purge requires backup_directory');
  const allowed = ['history', 'materials', 'resumes', 'reports', 'profile'];
  const requested = input.scopes || allowed;
  if (!Array.isArray(requested) || !requested.length || requested.some(scope => !allowed.includes(scope))) throw new Error(`Purge scopes: ${allowed.join(', ')}`);
  const scopes = requested.includes('history') ? [...new Set([...requested, 'reports'])] : requested;
  const dir = resolve(directory);
  const backup = backupData(dir, input.backup_directory);
  if (scopes.includes('history')) invalidateAuthorization(dir, 'history_purged');
  if (scopes.includes('history')) for (const name of ['history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm']) {
    const path = localPath(dir, name); if (existsSync(path)) rmSync(path, { force: true });
  }
  for (const scope of ['materials', 'resumes', 'reports']) if (scopes.includes(scope)) {
    const path = localPath(dir, scope); if (existsSync(path)) rmSync(path, { recursive: true, force: true }); mkdirSync(path, { mode: 0o700 });
  }
  if (scopes.includes('profile')) {
    if (scopes.includes('history')) {
      for (const name of ['profile.json', 'policy.json', 'profile.md', 'intake.md']) atomicWrite(localPath(dir, name), readBytes(join(ROOT, 'templates', name)), { base: dir });
    } else {
      const store = new Tracker(dir);
      try {
        for (const name of ['profile.json', 'policy.json']) {
          const current = readBytes(localPath(dir, name), { base: dir });
          store.writeManagedJSON(name, readJSON(join(ROOT, 'templates', name)), { expectedSha256: sha256(current), eventKind: `${name.split('.')[0]}_purged`, eventPayload: {} });
        }
      } finally { store.close(); }
      for (const name of ['profile.md', 'intake.md']) atomicWrite(localPath(dir, name), readBytes(join(ROOT, 'templates', name)), { base: dir });
    }
  }
  initData(dir);
  return { purged: scopes, backup };
}

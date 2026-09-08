import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathInside } from '../bin/jobhunt-kit.mjs';
import { runCommand } from '../plugins/jobhunt-kit/scripts/commands.mjs';
import { backupData, purgeData, redactData, restoreData, verifyBackup } from '../plugins/jobhunt-kit/scripts/maintenance.mjs';
import { checkResume, recordResumeReview } from '../plugins/jobhunt-kit/scripts/resume.mjs';
import { confirmProfile } from '../plugins/jobhunt-kit/scripts/profile.mjs';
import { sendPacket } from '../plugins/jobhunt-kit/scripts/send-packet.mjs';
import { Tracker, initData } from '../plugins/jobhunt-kit/scripts/tracker.mjs';
import { validateSchema } from '../plugins/jobhunt-kit/scripts/validation.mjs';

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) {
    const absolute = resolve(root);
    assert.ok(absolute.startsWith(resolve(tmpdir())) && absolute.includes('jobhunt-hardening-'));
    rmSync(absolute, { recursive: true, force: true });
  }
});

function temporary(t, prefix = 'jobhunt-hardening-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function ready(t) {
  const dir = join(temporary(t), 'data');
  initData(dir);
  const file = join(dir, 'profile.json');
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  profile.confirmed_at = new Date().toISOString();
  profile.identity.name = 'Fictional Candidate';
  profile.search.roles = ['Fictional Engineer'];
  profile.hirify_profile_id = 123;
  profile.evidence = [{ id: 'E1', text: 'Fictional evidence', source: 'fixture', confirmed: true }];
  const resume = Buffer.from('Fictional resume');
  writeFileSync(join(dir, 'resumes', 'fictional.txt'), resume);
  profile.resume = { path: 'resumes/fictional.txt', sha256: createHash('sha256').update(resume).digest('hex'), review_status: 'ready' };
  writeFileSync(file, JSON.stringify(profile));
  const fixtureStore = new Tracker(dir);
  fixtureStore.writeManagedJSON('profile.json', profile, { expectedSha256: createHash('sha256').update(readFileSync(file)).digest('hex'), eventKind: 'fictional_fixture_ready' });
  fixtureStore.close();
  return dir;
}

function prepared(t) {
  const dir = ready(t);
  const store = new Tracker(dir);
  const run = store.runStart({ source: 'fixture' });
  store.put({ run_id: run.run_id, slug: 'fictional', title: 'Original fictional title', url: 'https://example.invalid/f', route: 'hosted',
    description: 'Fictional full text', read_at: new Date().toISOString(), match: { verdict: 'suitable', reasons: ['Fixture'], requirements: [{ requirement: 'Evidence', result: 'pass', evidence: 'E1' }] } });
  store.runFinish({ run_id: run.run_id, status: 'complete', reason: 'Fixture complete' });
  store.prepare({ slug: 'fictional', cover_letter: 'Fictional cover', hirify_profile_id: 123,
    claims: [{ text: 'Fictional evidence', evidence_id: 'E1' }], answers: [], unresolved: [] });
  return { dir, store };
}

test('JSON schemas reject malformed profile and vacancy input', () => {
  assert.throws(() => validateSchema('profile', { schema_version: 1 }), /required property/);
  assert.throws(() => validateSchema('vacancy', { run_id: 'x', slug: '../escape' }), /schema/);
});

test('only one search can run and finished runs reject late events', t => {
  const dir = ready(t);
  const first = new Tracker(dir);
  const second = new Tracker(dir);
  t.after(() => { first.close(); second.close(); });
  const run = first.runStart({});
  assert.throws(() => second.runStart({}), /previous running search/);
  first.runFinish({ run_id: run.run_id, status: 'complete', reason: 'done' });
  assert.throws(() => second.runEvent({ run_id: run.run_id, kind: 'late' }), /finished run/);
});

test('replaced auto authorization invalidates a reserved packet', t => {
  const { dir, store } = prepared(t);
  t.after(() => store.close());
  const profileHash = store.profile().hash;
  const expires_at = new Date(Date.now() + 3600000).toISOString();
  store.policy({ mode: 'auto', auto: { user_authorization: 'Old fictional authorization', profile_hash: profileHash, expires_at, max_attempts_per_utc_day: 5 } });
  const packet = store.begin({ slug: 'fictional' });
  store.policy({ mode: 'auto', auto: { user_authorization: 'Replacement fictional authorization', profile_hash: profileHash, expires_at, max_attempts_per_utc_day: 1 } });
  let calls = 0;
  assert.throws(() => sendPacket(dir, packet, () => { calls++; return { status: 0 }; }), /permission changed/);
  assert.equal(calls, 0);
});

test('application report uses immutable vacancy snapshot after later observations', t => {
  const { store } = prepared(t);
  t.after(() => store.close());
  store.approve({ slug: 'fictional', user_authorization: 'Fictional approval' });
  const packet = store.begin({ slug: 'fictional' });
  store.dispatch(packet);
  store.finish({ attempt_id: packet.attempt_id, outcome: 'submitted', application_id: 'fictional-id', evidence: 'Fixture response' });
  const run = store.runStart({});
  store.put({ run_id: run.run_id, slug: 'fictional', title: 'Changed live title', url: 'https://example.invalid/f', route: 'hosted',
    description: 'Changed text', read_at: new Date().toISOString(), match: { verdict: 'suitable', reasons: ['Changed'], requirements: [{ requirement: 'Evidence', result: 'pass', evidence: 'E1' }] } });
  assert.match(store.report().content, /Original fictional title/);
  assert.doesNotMatch(store.report().content, /Changed live title/);
});

test('registered resume cannot escape local data directory', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  writeFileSync(join(root, 'outside.txt'), 'FICTIONAL OUTSIDE');
  const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  profile.resume = { path: '../outside.txt', sha256: '0'.repeat(64), review_status: 'not_reviewed' };
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
  assert.throws(() => checkResume(dir), /escapes the local data directory/);
  assert.throws(() => recordResumeReview(dir, { sha256: '0'.repeat(64), status: 'needs_changes', evidence: 'Fictional review' }), /escapes the local data directory/);
});

test('managed profile write recovers from an interrupted journal entry', t => {
  const dir = join(temporary(t), 'data');
  initData(dir);
  const file = join(dir, 'profile.json');
  const oldBytes = readFileSync(file);
  const profile = JSON.parse(oldBytes);
  profile.identity.name = 'Recovered Fictional Name';
  const content = JSON.stringify(profile, null, 2) + '\n';
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  db.prepare('INSERT INTO pending_file_writes(id,name,old_sha256,new_sha256,content,event_kind,event_payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('fixture-write', 'profile.json', createHash('sha256').update(oldBytes).digest('hex'), createHash('sha256').update(content).digest('hex'), content, 'profile_saved', '{}', new Date().toISOString());
  db.close();
  const recovered = new Tracker(dir);
  try {
    assert.equal(recovered.profile(false).profile.identity.name, 'Recovered Fictional Name');
    assert.equal(recovered.integrity().pending_file_writes.length, 0);
    assert.equal(recovered.history().at(-1).payload.recovered_interrupted_write, true);
  } finally { recovered.close(); }
});

test('resume review preserves a profile recovered before the command read', t => {
  const dir = ready(t);
  const file = join(dir, 'profile.json');
  const oldBytes = readFileSync(file);
  const recovered = JSON.parse(oldBytes);
  recovered.identity.name = 'Recovered Fictional Name';
  const content = JSON.stringify(recovered, null, 2) + '\n';
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  db.prepare('INSERT INTO pending_file_writes(id,name,old_sha256,new_sha256,content,event_kind,event_payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('resume-recovery', 'profile.json', createHash('sha256').update(oldBytes).digest('hex'), createHash('sha256').update(content).digest('hex'), content, 'profile_saved', '{}', new Date().toISOString());
  db.close();
  recordResumeReview(dir, { sha256: recovered.resume.sha256, status: 'needs_changes', evidence: 'Fictional review after recovery' });
  const finalProfile = JSON.parse(readFileSync(file));
  assert.equal(finalProfile.identity.name, 'Recovered Fictional Name');
  assert.equal(finalProfile.resume.review_status, 'needs_changes');
});

test('profile confirm preserves a profile recovered before the command read', t => {
  const dir = ready(t);
  const file = join(dir, 'profile.json');
  const oldBytes = readFileSync(file);
  const recovered = JSON.parse(oldBytes);
  recovered.identity.name = 'Recovered Before Confirm';
  const content = JSON.stringify(recovered, null, 2) + '\n';
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  db.prepare('INSERT INTO pending_file_writes(id,name,old_sha256,new_sha256,content,event_kind,event_payload,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('confirm-recovery', 'profile.json', createHash('sha256').update(oldBytes).digest('hex'), createHash('sha256').update(content).digest('hex'), content, 'profile_saved', '{}', new Date().toISOString());
  db.close();
  confirmProfile(dir, 'Fictional explicit confirmation');
  const finalProfile = JSON.parse(readFileSync(file));
  assert.equal(finalProfile.identity.name, 'Recovered Before Confirm');
  assert.ok(finalProfile.confirmed_at);
});

test('managed JSON refuses pretty output above the readable size limit', t => {
  const dir = join(temporary(t), 'data');
  initData(dir);
  const file = join(dir, 'profile.json');
  const original = readFileSync(file);
  const profile = JSON.parse(original);
  profile.skills = Array.from({ length: 85000 }, () => ({ name: 'Fictional' }));
  const store = new Tracker(dir);
  try {
    assert.throws(() => store.writeManagedJSON('profile.json', profile, { expectedSha256: createHash('sha256').update(original).digest('hex'), eventKind: 'fixture' }), /serialized output exceeds/);
    assert.deepEqual(readFileSync(file), original);
    assert.equal(store.integrity().pending_file_writes.length, 0);
  } finally { store.close(); }
});

test('backup verifies, restore keeps an automatic safety copy, and redaction is audited', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  const backup = join(root, 'backup');
  assert.equal(backupData(dir, backup).files > 0, true);
  assert.equal(verifyBackup(backup).valid, true);
  const profile = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
  profile.identity.name = 'Fictional Changed';
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
  const restored = restoreData(dir, backup, 'RESTORE VERIFIED JOBHUNT BACKUP');
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'))).identity.name, null);
  assert.equal(existsSync(join(restored.automatic_quarantine, 'quarantine-manifest.json')), true);
  assert.equal(JSON.parse(readFileSync(join(restored.automatic_quarantine, 'profile.json'))).identity.name, 'Fictional Changed');
  const store = new Tracker(dir);
  const bytes = readFileSync(join(dir, 'profile.json'));
  profile.identity.name = 'Fictional PII';
  profile.confirmed_at = null;
  store.writeManagedJSON('profile.json', profile, { expectedSha256: createHash('sha256').update(bytes).digest('hex'), eventKind: 'fixture', eventPayload: {} });
  store.close();
  const result = redactData(dir, { confirmation: 'REDACT LOCAL JOBHUNT PII', fields: ['identity.name'] });
  assert.deepEqual(result.redacted, ['identity.name']);
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'))).identity.name, null);
  writeFileSync(join(dir, 'reports', 'latest.md'), 'FICTIONAL PRIVATE HISTORY');
  const purged = purgeData(dir, { confirmation: 'PURGE LOCAL JOBHUNT DATA', backup_directory: join(root, 'purge-backup'), scopes: ['history', 'materials', 'resumes', 'profile'] });
  assert.deepEqual(purged.purged, ['history', 'materials', 'resumes', 'profile', 'reports']);
  assert.equal(existsSync(join(dir, 'reports', 'latest.md')), false);
  assert.equal(verifyBackup(join(root, 'purge-backup')).valid, true);
  const empty = new Tracker(dir);
  try { assert.equal(empty.history().length, 0); } finally { empty.close(); }
});

test('restore accepts corrupted live JSON and backup verification rejects unmanifested files', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  const backup = join(root, 'backup');
  backupData(dir, backup);
  writeFileSync(join(backup, 'materials', 'UNMANIFESTED.txt'), 'FICTIONAL EXTRA');
  assert.throws(() => verifyBackup(backup), /exactly match/);
  rmSync(join(backup, 'materials', 'UNMANIFESTED.txt'));
  writeFileSync(join(dir, 'profile.json'), '{broken');
  const restored = restoreData(dir, backup, 'RESTORE VERIFIED JOBHUNT BACKUP');
  assert.equal(verifyBackup(backup).valid, true);
  assert.equal(readFileSync(join(restored.automatic_quarantine, 'profile.json'), 'utf8'), '{broken');
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'))).schema_version, 1);
});

test('CLI verifies and restores a backup when the live profile is missing', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  const backup = join(root, 'backup');
  backupData(dir, backup);
  rmSync(join(dir, 'profile.json'));
  assert.equal(runCommand(['backup-verify', backup, '--data', dir], { cwd: root }).valid, true);
  const request = join(root, 'restore.json');
  writeFileSync(request, JSON.stringify({ source: backup, confirmation: 'RESTORE VERIFIED JOBHUNT BACKUP' }));
  assert.equal(runCommand(['restore', '--input', request, '--data', dir], { cwd: root }).restored, true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'))).schema_version, 1);
  const newDir = join(root, 'new-data');
  restoreData(newDir, backup, 'RESTORE VERIFIED JOBHUNT BACKUP');
  assert.equal(readFileSync(join(newDir, '.gitignore'), 'utf8'), '*\n');
});

test('backup refuses a valid JSON file that is not tracked by SQLite revision state', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  const profilePath = join(dir, 'profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.identity.name = 'Untracked Fictional Change';
  writeFileSync(profilePath, JSON.stringify(profile));
  assert.throws(() => backupData(dir, join(root, 'backup')), /invalid data/);
});

test('backup verifier accepts a generated-format manifest above the ordinary JSON limit', t => {
  const root = temporary(t);
  const dir = join(root, 'data');
  initData(dir);
  const backup = join(root, 'backup');
  backupData(dir, backup);
  const manifestPath = join(backup, 'backup-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.note = 'F'.repeat(2 * 1024 * 1024);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(verifyBackup(backup).valid, true);
});

test('history purge and restore revoke reusable auto authorization', t => {
  const root = temporary(t);
  const restoredDir = ready(t);
  let store = new Tracker(restoredDir);
  store.policy({ mode: 'auto', auto: { user_authorization: 'Fictional scoped approval', profile_hash: store.profile().hash,
    expires_at: new Date(Date.now() + 3600000).toISOString(), max_attempts_per_utc_day: 1 } });
  store.close();
  const backup = join(root, 'auto-backup');
  backupData(restoredDir, backup);
  restoreData(restoredDir, backup, 'RESTORE VERIFIED JOBHUNT BACKUP');
  assert.equal(JSON.parse(readFileSync(join(restoredDir, 'profile.json'))).confirmed_at, null);
  assert.equal(JSON.parse(readFileSync(join(restoredDir, 'policy.json'))).mode, 'review_each');

  const purgedDir = ready(t);
  store = new Tracker(purgedDir);
  store.policy({ mode: 'auto', auto: { user_authorization: 'Fictional scoped approval', profile_hash: store.profile().hash,
    expires_at: new Date(Date.now() + 3600000).toISOString(), max_attempts_per_utc_day: 1 } });
  store.close();
  purgeData(purgedDir, { confirmation: 'PURGE LOCAL JOBHUNT DATA', backup_directory: join(root, 'purge-backup'), scopes: ['history'] });
  assert.equal(JSON.parse(readFileSync(join(purgedDir, 'profile.json'))).confirmed_at, null);
  assert.equal(JSON.parse(readFileSync(join(purgedDir, 'policy.json'))).mode, 'review_each');
});

test('reserved attempt packet can be recreated idempotently', t => {
  const { dir, store } = prepared(t);
  store.approve({ slug: 'fictional', user_authorization: 'Fictional approval' });
  const packet = store.begin({ slug: 'fictional' });
  store.close();
  const recovered = runCommand(['recover', 'packet', packet.attempt_id, '--data', dir]);
  assert.equal(recovered.attempt_id, packet.attempt_id);
  assert.deepEqual(JSON.parse(readFileSync(recovered.packet_path)), packet);
  assert.deepEqual(runCommand(['recover', 'packet', packet.attempt_id, '--data', dir]), recovered);
});

test('v1 database migrates to v2 and closes duplicate running searches', t => {
  const dir = join(temporary(t), 'legacy');
  mkdirSync(dir, { recursive: true });
  for (const name of ['profile.json', 'policy.json']) copyFileSync(join('plugins', 'jobhunt-kit', 'templates', name), join(dir, name));
  const db = new DatabaseSync(join(dir, 'history.sqlite'));
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,status TEXT NOT NULL,profile_hash TEXT NOT NULL,input TEXT NOT NULL,result TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,canonical_url TEXT UNIQUE NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,draft TEXT,approval TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE aliases(slug TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id));
    CREATE TABLE observations(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),job_id TEXT NOT NULL REFERENCES jobs(id),at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE attempts(id TEXT PRIMARY KEY,job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),started_at TEXT NOT NULL,mode TEXT NOT NULL,packet TEXT NOT NULL,result TEXT);
    CREATE TABLE dispatches(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),at TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,kind TEXT NOT NULL,job_id TEXT,run_id TEXT,payload TEXT NOT NULL);
    INSERT INTO runs VALUES('old','2026-01-01',NULL,'running','x','{}',NULL),('new','2026-01-02',NULL,'running','x','{}',NULL);
    PRAGMA user_version=1;`);
  db.close();
  const store = new Tracker(dir);
  t.after(() => store.close());
  assert.equal(store.integrity().schema_version, 2);
  assert.equal(store.integrity().migrations.at(-1).version, 2);
  assert.deepEqual(store.integrity().running_runs.map(row => row.id), ['new']);
  assert.equal(store.runs().find(row => row.id === 'old').status, 'blocked');
});

test('Windows path containment allows a destination on another volume', () => {
  assert.equal(pathInside('C:\\npm\\jobhunt-kit', 'D:\\work\\jobhunt', win32), false);
  assert.equal(pathInside('C:\\npm\\jobhunt-kit', 'C:\\npm\\jobhunt-kit\\child', win32), true);
});

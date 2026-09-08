#!/usr/bin/env node
// Local bookkeeping only. No network, credentials, or application sending here.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJSON = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const need = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const safeURL = value => {
  const u = new URL(value);
  need(['https:', 'http:'].includes(u.protocol) && !u.username && !u.password, 'Expected public HTTP(S) URL');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.toString();
};

export function initData(directory) {
  const dir = resolve(directory);
  // Never store candidate state in a plugin cache, including a locally loaded plugin.
  need(dir !== ROOT && !dir.startsWith(ROOT + '/') && !dir.startsWith(ROOT + '\\'), 'Data must be outside the plugin directory');
  mkdirSync(dir, { recursive: true });
  for (const file of ['profile.json', 'policy.json', 'profile.md', 'intake.md']) {
    if (!existsSync(join(dir, file))) copyFileSync(join(ROOT, 'templates', file), join(dir, file));
  }
  for (const folder of ['resumes', 'materials', 'reports']) mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*\n');
  const store = new Tracker(dir);
  store.close();
  return { data: dir, initialized: true, profile: 'empty unless previously populated' };
}

export class Tracker {
  constructor(directory) {
    this.dir = resolve(directory);
    need(existsSync(join(this.dir, 'profile.json')), 'Run init first');
    this.db = new DatabaseSync(join(this.dir, 'history.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) { this.db.close(); throw new Error('Unsupported database version; explicit migration required'); }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL, profile_hash TEXT NOT NULL, input TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, canonical_url TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL, payload TEXT NOT NULL, draft TEXT, approval TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(slug TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id));
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        job_id TEXT NOT NULL REFERENCES jobs(id), at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id),
        started_at TEXT NOT NULL, mode TEXT NOT NULL, packet TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS dispatches(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL,
        job_id TEXT, run_id TEXT, payload TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(kind, payload, job = null, run = null) {
    this.db.prepare('INSERT INTO events(at,kind,job_id,run_id,payload) VALUES(?,?,?,?,?)')
      .run(now(), kind, job, run, JSON.stringify(payload));
  }
  profile(requireReady = true) {
    const profile = readJSON(join(this.dir, 'profile.json'));
    need(profile.schema_version === 1, 'Unsupported profile schema');
    if (requireReady) {
      need(text(profile.confirmed_at) && Number.isFinite(Date.parse(profile.confirmed_at)), 'Candidate must confirm profile before search/apply');
      need(Array.isArray(profile.search?.roles) && profile.search.roles.length > 0 && profile.search.roles.every(text), 'Profile needs target roles');
    }
    return { profile, hash: hash(profile) };
  }
  job(slug) {
    const row = this.db.prepare('SELECT jobs.* FROM jobs JOIN aliases ON jobs.id=aliases.job_id WHERE aliases.slug=?').get(slug);
    need(row, 'Unknown vacancy slug');
    return { ...row, payload: JSON.parse(row.payload), draft: row.draft && JSON.parse(row.draft), approval: row.approval && JSON.parse(row.approval) };
  }
  runStart(input) {
    const p = this.profile();
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES(?,?,NULL,?,?,?,NULL)').run(id, now(), 'running', p.hash, JSON.stringify(input));
    return { run_id: id, profile_hash: p.hash };
  }
  runEvent(input) {
    need(this.db.prepare('SELECT id FROM runs WHERE id=?').get(input.run_id), 'Unknown run');
    need(text(input.kind), 'Event kind required');
    this.event(input.kind, input.data ?? {}, null, input.run_id);
    return { recorded: true };
  }
  runFinish(input) {
    need(['complete', 'partial', 'blocked', 'failed'].includes(input.status), 'Invalid run result');
    need(text(input.reason), 'Run stop reason required');
    const result = this.db.prepare('UPDATE runs SET status=?,finished_at=?,result=? WHERE id=? AND status=?')
      .run(input.status, now(), JSON.stringify(input), input.run_id, 'running');
    need(result.changes === 1, 'Unknown or already finished run');
    return { recorded: true };
  }
  put(input) {
    need(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.slug), 'Invalid slug');
    need(text(input.title), 'Title required');
    const canonical = safeURL(input.original_url || input.url);
    safeURL(input.url);
    need(['hosted', 'external', 'unknown'].includes(input.route), 'Invalid route');
    need(['unreviewed', 'suitable', 'review', 'rejected'].includes(input.match?.verdict), 'Match verdict required');
    if (input.match.verdict !== 'unreviewed') {
      need(text(input.description) && text(input.read_at), 'Read full vacancy before assessing fit');
      need(Array.isArray(input.match.reasons) && input.match.reasons.length > 0, 'Explain match');
    }
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=? AND status=?').get(input.run_id, 'running');
      need(run, 'Running search required');
      need(run.profile_hash === this.profile().hash, 'Profile changed; start a new search run');
      const alias = this.db.prepare('SELECT job_id FROM aliases WHERE slug=?').get(input.slug);
      const sameURL = this.db.prepare('SELECT id FROM jobs WHERE canonical_url=?').get(canonical);
      need(!alias || !sameURL || alias.job_id === sameURL.id, 'Conflicting identity; manual deduplication required');
      const id = alias?.job_id || sameURL?.id || randomUUID();
      const existing = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
      // Keep canonical full text on a later card-only observation; never regress status.
      const old = existing && JSON.parse(existing.payload);
      const payload = old && input.match.verdict === 'unreviewed' ? old : { ...input, profile_hash: run.profile_hash };
      if (!existing) {
        this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,NULL,NULL,?,?)')
          .run(id, canonical, 'discovered', JSON.stringify(payload), now(), now());
      } else {
        this.db.prepare('UPDATE jobs SET payload=?,updated_at=? WHERE id=?').run(JSON.stringify(payload), now(), id);
      }
      this.db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(input.slug, id);
      this.db.prepare('INSERT INTO observations(run_id,job_id,at,payload) VALUES(?,?,?,?)').run(input.run_id, id, now(), JSON.stringify(input));
      return { id, is_new: !existing, status: existing?.status || 'discovered' };
    });
  }
  prepare(input) {
    return this.transaction(() => {
      const job = this.job(input.slug);
      need(['discovered', 'draft', 'needs_user', 'approved'].includes(job.status), 'Vacancy cannot be drafted in this status');
      const p = this.profile();
      need(job.payload.profile_hash === p.hash, 'Reassess vacancy for current profile');
      need(['suitable', 'review'].includes(job.payload.match.verdict), 'Vacancy must be assessed first');
      need(text(input.cover_letter), 'Cover letter required');
      need(Array.isArray(input.claims) && Array.isArray(input.unresolved), 'claims and unresolved arrays required');
      const evidence = new Map((p.profile.evidence || []).map(e => [e.id, e]));
      for (const claim of input.claims) need(text(claim.text) && evidence.get(claim.evidence_id)?.confirmed === true, 'Each claim needs confirmed profile evidence');
      const draft = { ...input, profile_hash: p.hash, vacancy_hash: hash(job.payload) };
      const status = job.payload.route === 'external' || input.unresolved.length ? 'needs_user' : 'draft';
      this.db.prepare('UPDATE jobs SET draft=?,approval=NULL,status=?,updated_at=? WHERE id=?').run(JSON.stringify(draft), status, now(), job.id);
      this.event('draft_prepared', { draft_hash: hash(draft) }, job.id);
      return { slug: input.slug, status, draft_hash: hash(draft) };
    });
  }
  approve(input) {
    return this.transaction(() => {
      const job = this.job(input.slug);
      need(job.status === 'draft' && job.draft, 'Prepare a complete draft first');
      need(text(input.user_authorization), 'Record explicit user approval for this exact application');
      need(job.draft.profile_hash === this.profile().hash && job.draft.vacancy_hash === hash(job.payload), 'Draft is stale');
      const approval = { at: now(), draft_hash: hash(job.draft), user_authorization: input.user_authorization };
      this.db.prepare('UPDATE jobs SET approval=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(approval), 'approved', now(), job.id);
      this.event('approved', approval, job.id);
      return approval;
    });
  }
  policy(input) {
    const current = readJSON(join(this.dir, 'policy.json'));
    need(['review_each', 'auto'].includes(input.mode), 'Invalid policy mode');
    if (input.mode === 'auto') {
      need(text(input.auto?.user_authorization), 'Explicit scoped user authorization required');
      need(Date.parse(input.auto.expires_at) > Date.now(), 'Future expiry required');
      need(Number.isInteger(input.auto.max_attempts_per_utc_day) && input.auto.max_attempts_per_utc_day > 0, 'Positive daily attempt cap required');
      need(input.auto.profile_hash === this.profile().hash, 'Auto authorization must bind current profile hash');
    }
    const policy = { ...current, mode: input.mode, auto: input.mode === 'auto' ? input.auto : null };
    writeFileSync(join(this.dir, 'policy.json'), JSON.stringify(policy, null, 2) + '\n');
    this.event('policy_changed', policy);
    return policy;
  }
  begin(input) {
    return this.transaction(() => {
      const job = this.job(input.slug);
      const p = this.profile();
      need(['draft', 'approved'].includes(job.status) && job.draft, 'Complete unsent draft required');
      need(job.payload.route === 'hosted', 'Only Hirify-hosted vacancies can be sent');
      need(job.payload.match.verdict === 'suitable', 'Only suitable vacancies can be sent');
      need(job.draft.unresolved.length === 0, 'Unresolved answers prevent sending');
      need(job.draft.profile_hash === p.hash && job.draft.vacancy_hash === hash(job.payload), 'Draft stale; prepare and approve again');
      need(Number.isInteger(p.profile.hirify_profile_id) && p.profile.hirify_profile_id > 0 && job.draft.hirify_profile_id === p.profile.hirify_profile_id, 'Confirm exact Hirify profile');
      need(p.profile.resume?.review_status === 'ready', 'Resume review not ready');
      need(text(p.profile.resume.path) && text(p.profile.resume.sha256), 'Resume file and fingerprint required');
      const resume = resolve(this.dir, p.profile.resume.path);
      need(createHash('sha256').update(readFileSync(resume)).digest('hex') === p.profile.resume.sha256, 'Resume file changed; review and update profile');
      const policy = readJSON(join(this.dir, 'policy.json'));
      const approved = job.approval?.draft_hash === hash(job.draft);
      let mode = 'review_each';
      if (!approved) {
        mode = 'auto';
        const auto = policy.auto;
        need(policy.mode === 'auto' && auto && text(auto.user_authorization), 'Explicit approval required');
        need(auto.profile_hash === p.hash && Date.parse(auto.expires_at) > Date.now(), 'Auto authorization expired or profile changed');
        need(Number.isInteger(auto.max_attempts_per_utc_day) && auto.max_attempts_per_utc_day > 0, 'Invalid auto cap');
        const requirements = job.payload.match.requirements;
        need(Array.isArray(requirements) && requirements.length > 0 && requirements.every(r => r.result === 'pass' && text(r.evidence)), 'Auto mode requires all critical requirements checked');
        const used = this.db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE started_at>=?').get(now().slice(0, 10)).count;
        need(used < auto.max_attempts_per_utc_day, 'Local daily attempt cap reached (UTC)');
      }
      // UNIQUE(job_id) is the durable duplicate-send guard, including unknown results.
      const attempt = randomUUID();
      const packet = { ...job.draft, slug: job.payload.slug, mode, attempt_id: attempt };
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,NULL)').run(attempt, job.id, now(), mode, JSON.stringify(packet));
      this.db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run('submitting', now(), job.id);
      this.event('send_intent', { attempt_id: attempt, mode }, job.id);
      return packet;
    });
  }
  finish(input) {
    need(['submitted', 'failed', 'unknown'].includes(input.outcome), 'Invalid send outcome');
    need(text(input.evidence), 'Response or uncertainty evidence required');
    if (input.outcome === 'submitted') need(text(input.application_id), 'Successful Hirify response must include application ID');
    return this.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(input.attempt_id);
      need(attempt, 'Unknown attempt');
      if (attempt.result) {
        need(JSON.parse(attempt.result).outcome === input.outcome, 'Use resolve for an unknown result');
        return { unchanged: true };
      }
      this.db.prepare('UPDATE attempts SET result=? WHERE id=?').run(JSON.stringify(input), attempt.id);
      const status = input.outcome === 'unknown' ? 'submission_unknown' : input.outcome;
      this.db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run(status, now(), attempt.job_id);
      this.event('send_result', input, attempt.job_id);
      return { status };
    });
  }
  dispatch(packet) {
    return this.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(packet.attempt_id);
      need(attempt && !attempt.result && hash(JSON.parse(attempt.packet)) === hash(packet), 'Packet must exactly match pending saved attempt');
      const job = this.job(packet.slug);
      need(job.status === 'submitting' && job.id === attempt.job_id, 'Attempt is not pending');
      const p = this.profile();
      need(p.hash === packet.profile_hash && hash(job.payload) === packet.vacancy_hash, 'Profile or vacancy changed after begin');
      need(createHash('sha256').update(readFileSync(resolve(this.dir, p.profile.resume.path))).digest('hex') === p.profile.resume.sha256, 'Resume changed after begin');
      if (packet.mode === 'auto') {
        const policy = readJSON(join(this.dir, 'policy.json'));
        need(policy.mode === 'auto' && policy.auto?.profile_hash === p.hash && Date.parse(policy.auto.expires_at) > Date.now(), 'Auto permission revoked or expired');
      } else need(job.approval?.draft_hash === hash(job.draft), 'Approval no longer valid');
      this.db.prepare('INSERT INTO dispatches VALUES(?,?)').run(attempt.id, now());
      this.event('cli_dispatch', { attempt_id: attempt.id }, job.id);
      return { claimed: true };
    });
  }
  resolveUnknown(input) {
    need(['submitted', 'failed'].includes(input.outcome) && text(input.evidence), 'Verified outcome and evidence required');
    if (input.outcome === 'submitted') need(text(input.application_id), 'Application ID required');
    return this.transaction(() => {
      const job = this.job(input.slug);
      need(['submission_unknown', 'submitting'].includes(job.status), 'No uncertain attempt to resolve');
      const attempt = this.db.prepare('SELECT * FROM attempts WHERE job_id=?').get(job.id);
      need(attempt, 'Missing attempt');
      this.db.prepare('UPDATE attempts SET result=? WHERE id=?').run(JSON.stringify(input), attempt.id);
      this.db.prepare('UPDATE jobs SET status=?,updated_at=? WHERE id=?').run(input.outcome, now(), job.id);
      this.event('uncertainty_resolved', input, job.id);
      return { status: input.outcome, automatic_retry: false };
    });
  }
  status(input) {
    const allowed = {
      discovered: ['dismissed', 'needs_user'], draft: ['dismissed', 'needs_user'],
      approved: ['dismissed', 'needs_user'], needs_user: ['dismissed', 'submitted_external'],
      submitted: ['interview', 'rejected', 'withdrawn', 'offer'],
      submitted_external: ['interview', 'rejected', 'withdrawn', 'offer'],
      interview: ['interview', 'rejected', 'withdrawn', 'offer'], offer: ['accepted', 'declined', 'withdrawn']
    };
    return this.transaction(() => {
      const job = this.job(input.slug);
      need(allowed[job.status]?.includes(input.status), 'Invalid status transition');
      need(text(input.note), 'User report or source evidence required');
      if (input.status === 'submitted_external') need(job.payload.route === 'external', 'External route required');
      this.db.prepare('UPDATE jobs SET status=?,approval=NULL,updated_at=? WHERE id=?').run(input.status, now(), job.id);
      this.event('status_changed', { ...input, previous: job.status }, job.id);
      return { status: input.status };
    });
  }
  list() {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all().map(r => ({ ...r, payload: JSON.parse(r.payload), draft: r.draft && JSON.parse(r.draft), approval: r.approval && JSON.parse(r.approval) }));
  }
  history() { return this.db.prepare('SELECT * FROM events ORDER BY id').all().map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  runs() { return this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all().map(r => ({ ...r, input: JSON.parse(r.input), result: r.result && JSON.parse(r.result) })); }
  report() {
    const esc = v => String(v ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const lines = ['# Поиск работы — локальный отчёт', '', `Обновлён: ${now()}`, '',
      'История SQLite; ответы работодателей вносятся по сообщению пользователя.', '',
      '| Вакансия | Статус | Совпадение / причины | Следующий шаг |', '|---|---|---|---|'];
    for (const job of this.list()) {
      const next = ({ discovered: 'Проверить и подготовить', draft: 'Согласовать отклик', approved: 'Проверить квоту и отправить',
        needs_user: 'Ответы / ручной отклик', submitting: 'Проверить результат; не повторять', submission_unknown: 'Уточнить результат; не повторять',
        submitted: 'Ждать ответа', submitted_external: 'Ждать ответа', interview: 'Подготовиться к интервью', offer: 'Обсудить предложение' })[job.status] || 'Нет автоматического действия';
      lines.push(`| ${esc(job.payload.title)} (${esc(job.payload.url)}) | ${job.status} | ${esc(job.payload.match.verdict)}: ${esc(job.payload.match.reasons?.join('; '))} | ${next} |`);
    }
    lines.push('', '## Запуски', '');
    for (const run of this.runs()) lines.push(`- ${run.started_at}: ${run.status}; ${esc(run.result?.reason || 'Не завершён — проверить журнал перед продолжением')}`);
    const content = lines.join('\n') + '\n';
    const path = join(this.dir, 'reports', 'latest.md');
    writeFileSync(path, content);
    return { path, content };
  }
}

export function main(args) {
  need(args[0] === '--data' && text(args[1]), 'Usage: node tracker.mjs --data <directory> <command> [input.json|slug]');
  const [directory, command, argument] = args.slice(1);
  if (command === 'init') return initData(directory);
  const store = new Tracker(directory);
  try {
    const commands = { 'run-start': 'runStart', 'run-event': 'runEvent', 'run-finish': 'runFinish',
      put: 'put', prepare: 'prepare', approve: 'approve', policy: 'policy', begin: 'begin', finish: 'finish',
      resolve: 'resolveUnknown', status: 'status' };
    if (commands[command]) { need(argument, 'JSON input file required'); return store[commands[command]](readJSON(argument)); }
    if (command === 'show') return store.job(argument);
    if (command === 'profile') return store.profile(false);
    if (['list', 'history', 'runs', 'report'].includes(command)) return store[command]();
    throw new Error('Unknown command');
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (e) { console.error(`jobhunt-kit: ${e.message}`); process.exitCode = 1; }
}

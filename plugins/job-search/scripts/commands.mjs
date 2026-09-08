import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Tracker, initData } from './tracker.mjs';
import { readJSON, writeJSON, validateProfile, saveProfile, confirmProfile } from './profile.mjs';
import { importResume, checkResume, recordResumeReview } from './resume.mjs';
import { cliPath } from './hirify.mjs';
import { sendPacket } from './send-packet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = (value, name) => { if (!value) throw new Error(`${name} required`); return value; };
function using(dir, fn) { const s = new Tracker(dir); try { return fn(s); } finally { s.close(); } }
function exportDraft(dir, job) {
  if (!job.draft) throw new Error('Prepare a draft first');
  const version = createHash('sha256').update(JSON.stringify(job.draft)).digest('hex').slice(0, 16);
  const folder = join(dir, 'materials', `application-${job.id}-${version}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'cover-letter.txt'), job.draft.cover_letter);
  writeJSON(join(folder, 'answers.json'), job.draft.answers || []);
  writeJSON(join(folder, 'draft.json'), job.draft);
  const destination = job.payload.apply_url || job.payload.original_url || job.payload.url;
  writeFileSync(join(folder, 'handoff.md'), [
    '# Материалы отклика', '', `Вакансия: ${job.payload.title}`, `Ссылка: ${destination}`, '',
    `Маршрут: ${job.payload.route}. Статус: ${job.status}.`,
    'Письмо: cover-letter.txt. Ответы: answers.json. Полный снимок: draft.json.', '',
    '## Требует действия', ...(job.draft.unresolved || []).map(x => `- ${x}`), '',
    job.payload.route === 'external' ? 'Отклик отправляет пользователь. Если ссылка на форму ещё не раскрыта, сначала получить её через Hirify reveal.' : 'Перед отправкой проверить профиль Hirify и текущую квоту; требуется действующее согласование.',
    '', 'Экспорт файлов не отправляет отклик.'
  ].join('\n'));
  return { directory: folder, handoff: join(folder, 'handoff.md'), sent: false };
}
function searchContext(dir, workspace) {
  return using(dir, store => {
    const p = store.profile();
    const validation = validateProfile(p.profile);
    if (!validation.valid) throw new Error(validation.errors.join('; '));
    const policy = readJSON(join(dir, 'policy.json'));
    for (const k of ['target', 'max_cards', 'max_reads', 'max_reveals', 'max_minutes']) {
      if (!Number.isInteger(policy.search?.[k]) || policy.search[k] < (k === 'max_reveals' ? 0 : 1)) throw new Error(`Invalid search budget: ${k}`);
    }
    const context = { kind: 'agent_search_context', live_search_executed: false, profile_hash: p.hash,
      search: p.profile.search, evidence: p.profile.evidence, languages: p.profile.languages,
      budgets: { ...policy.search, target: Math.min(5, policy.search.target) },
      existing: store.list().map(j => ({ id: j.id, slug: j.payload.slug, url: j.canonical_url, status: j.status })),
      unfinished_runs: store.runs().filter(r => r.status === 'running'), next_skill: 'job-search' };
    const path = join(dir, 'materials', 'search-context.json');
    writeJSON(path, context);
    const task = join(dir, 'materials', 'search-task.md');
    const localPlugin = join(workspace, 'plugins', 'job-search');
    const plugin = existsSync(join(localPlugin, 'skills', 'job-search', 'SKILL.md')) ? localPlugin : ROOT;
    writeFileSync(task, `Use job-search at ${join(plugin, 'skills', 'job-search', 'SKILL.md')}.\nRead ${path} and ${join(dir, 'profile.json')}.\nCheck live Hirify quotas and filter guide, preview filters, then search. Record runs and observations using the CLI.\nNo live search has been performed by this context command.\n`);
    return { ...context, context_path: path, task_path: task };
  });
}
function scheduleTemplate(dir, workspace, input) {
  if (!['search', 'prepare', 'auto'].includes(input.mode)) throw new Error('Schedule mode must be search, prepare or auto');
  required(input.frequency, 'frequency'); required(input.timezone, 'timezone');
  new Intl.DateTimeFormat('en', { timeZone: input.timezone });
  const plugin = join(workspace, 'plugins', 'job-search');
  if (!existsSync(join(plugin, 'skills', 'job-search', 'SKILL.md'))) throw new Error('Schedule needs an installed workspace; pass --workspace to avoid storing an npm cache path');
  const template = readFileSync(join(ROOT, 'templates', 'scheduled-search.md'), 'utf8');
  let prompt = template;
  for (const [key, value] of Object.entries({ '<расписание>': input.frequency, '<IANA timezone>': input.timezone,
    '<абсолютный workspace>': workspace, '<абсолютный путь плагина>': plugin,
    '<абсолютный путь локальных данных>': dir, '<search / prepare / auto>': input.mode })) prompt = prompt.replaceAll(key, String(value));
  const path = join(dir, 'materials', 'scheduled-search.md');
  writeFileSync(path, prompt);
  return { path, scheduled: false, auto_permission_granted: false, next: 'Review prompt and create a task using your agent scheduler' };
}
export function runCommand(args, { cwd = process.cwd(), transport } = {}) {
  const { values: flags, positionals: pos } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { data: { type: 'string' }, workspace: { type: 'string' }, input: { type: 'string' }, note: { type: 'string' } } });
  const workspace = resolve(cwd, flags.workspace || '.');
  const dir = resolve(cwd, flags.data || join(workspace, 'local', 'job-search'));
  const input = () => readJSON(resolve(cwd, required(flags.input, '--input <json-file>')));
  const [command, action, argument] = pos;
  if (pos.length > 3) throw new Error('Too many arguments');
  if (command === 'doctor') {
    if (action) throw new Error('doctor takes no positional arguments');
    let cli; try { cli = { available: true, path: cliPath(dir), version: '0.4.5' }; }
    catch (e) { cli = { available: false, reason: e.message }; }
    const initialized = existsSync(join(dir, 'profile.json'));
    return { node: process.versions.node, workspace, data: dir, initialized, cli,
      profile: initialized ? validateProfile(readJSON(join(dir, 'profile.json'))) : null, network_checked: false,
      next: initialized ? 'profile check' : 'profile init' };
  }
  if (command === 'profile' && argument) throw new Error('Unexpected profile argument; use --input or --note');
  if (command === 'profile' && action === 'init') return initData(dir);
  if (!existsSync(join(dir, 'profile.json'))) throw new Error(`No profile at ${dir}. Run profile init first.`);
  if (command === 'profile') {
    if (argument) throw new Error('Unexpected profile argument; use --input or --note');
    if (action === 'save') return saveProfile(dir, input());
    if (action === 'confirm') return confirmProfile(dir, flags.note);
    if (action === 'show') return using(dir, s => s.profile(false));
    if (!action || action === 'check') return { ...validateProfile(readJSON(join(dir, 'profile.json'))), questionnaire: join(dir, 'intake.md') };
    throw new Error('profile: init | show | check | save --input file | confirm --note text');
  }
  if (command === 'resume') {
    if (['check', 'reviewed'].includes(action) && argument) throw new Error('Unexpected resume argument');
    if (action === 'reviewed') return recordResumeReview(dir, input());
    if (!action || action === 'check') return checkResume(dir);
    const file = action === 'import' ? required(argument, 'resume file') : action;
    if (action !== 'import' && argument) throw new Error('Unexpected resume argument');
    importResume(dir, resolve(cwd, file));
    return checkResume(dir);
  }
  if (command === 'search') {
    if (argument) throw new Error('Unexpected search argument; use --input');
    if (!action || action === 'plan') return searchContext(dir, workspace);
    const methods = { start: 'runStart', event: 'runEvent', record: 'put', finish: 'runFinish' };
    if (!methods[action]) throw new Error('search: plan | start | event | record | finish (JSON via --input)');
    return using(dir, s => {
      if (action === 'start' && s.runs().some(r => r.status === 'running')) throw new Error('Finish or resolve the previous running search before starting another');
      return s[methods[action]](input());
    });
  }
  if (command === 'apply') {
    if (['prepare', 'approve', 'send', 'finish', 'resolve'].includes(action) && argument) throw new Error('Unexpected apply argument; use --input');
    if (action === 'send') return sendPacket(dir, input(), transport);
    if (action === 'export') return using(dir, s => exportDraft(dir, s.job(required(argument, 'slug'))));
    if (action === 'begin') return using(dir, s => {
      const packet = s.begin({ slug: required(argument, 'slug') });
      const path = join(dir, 'materials', `attempt-${packet.attempt_id}.json`);
      writeJSON(path, packet);
      return { packet_path: path, attempt_id: packet.attempt_id, sent: false };
    });
    const methods = { prepare: 'prepare', approve: 'approve', finish: 'finish', resolve: 'resolveUnknown' };
    if (methods[action]) return using(dir, s => s[methods[action]](input()));
    if (action === 'preview') return using(dir, s => s.job(required(argument, 'slug')));
    if (action && !argument) return using(dir, s => s.job(action));
    throw new Error('apply: preview/export/begin <slug> | prepare/approve/send/finish/resolve --input file');
  }
  if (command === 'track') {
    if (action === 'list' && argument) throw new Error('track list takes no extra arguments');
    if (!action || action === 'list') return using(dir, s => s.list());
    if (action === 'show') return using(dir, s => s.job(required(argument, 'slug')));
    if (action === 'status') return using(dir, s => s.status({ ...input(), slug: required(argument, 'slug') }));
    throw new Error('track: list | show <slug> | status <slug> --input file');
  }
  if (['history', 'report', 'runs'].includes(command)) {
    if (action) throw new Error(`${command} takes no positional arguments`);
    return using(dir, s => s[command]());
  }
  if (command === 'policy') {
    if (argument) throw new Error('Unexpected policy argument');
    if (!action || action === 'show') return readJSON(join(dir, 'policy.json'));
    if (action === 'set') return using(dir, s => s.policy(input()));
    throw new Error('policy: show | set --input file');
  }
  if (command === 'schedule') {
    if (action) throw new Error('schedule takes --input, not positional arguments');
    return scheduleTemplate(dir, workspace, input());
  }
  throw new Error(`Unknown command: ${command}`);
}

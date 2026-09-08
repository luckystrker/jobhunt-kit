import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Tracker, initData } from '../plugins/jobhunt-kit/scripts/tracker.mjs';
import { sendPacket } from '../plugins/jobhunt-kit/scripts/send-packet.mjs';

function fixture(t, ready = true) {
  const dir = mkdtempSync(join(tmpdir(), 'job-search-test-'));
  initData(dir);
  const profilePath = join(dir, 'profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (ready) {
    profile.confirmed_at = '2026-01-01T00:00:00Z';
    profile.search.roles = ['Fictional librarian'];
    profile.hirify_profile_id = 123;
    profile.evidence = [{ id: 'E1', text: 'Fictional library experience', confirmed: true, source: 'synthetic fixture' }];
    writeFileSync(join(dir, 'resumes', 'fictional.txt'), 'Fictional resume for offline test only');
    profile.resume = { path: 'resumes/fictional.txt', sha256: createHash('sha256').update(readFileSync(join(dir, 'resumes', 'fictional.txt'))).digest('hex'), review_status: 'ready' };
    writeFileSync(profilePath, JSON.stringify(profile));
  }
  const store = new Tracker(dir);
  t.after(() => {
    store.close();
    const absolute = resolve(dir);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')) && absolute.includes('job-search-test-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  return { dir, store, profile, profilePath };
}
function vacancy(run, slug = 'fictional-a', route = 'hosted') {
  return { run_id: run.run_id, slug, title: 'Fictional library role', url: `https://example.invalid/${slug}`,
    route, description: 'Fictional vacancy, do not apply', read_at: '2026-01-01T00:00:00Z',
    match: { verdict: 'suitable', reasons: ['Fictional evidence match'], requirements: [{ requirement: 'Library skill', result: 'pass', evidence: 'E1 (synthetic)' }] } };
}
function prepare(store, slug = 'fictional-a', route = 'hosted') {
  const run = store.runStart({ query: 'fictional' });
  store.put(vacancy(run, slug, route));
  store.runFinish({ run_id: run.run_id, status: 'complete', reason: 'Synthetic fixture recorded' });
  store.prepare({ slug, cover_letter: 'Fictional "cover"\n$(do not execute) `literal`', hirify_profile_id: 123,
    claims: [{ text: 'Fictional library experience', evidence_id: 'E1' }], answers: [], unresolved: [] });
}
function auto(store, limit = 1) {
  store.policy({ mode: 'auto', auto: { user_authorization: 'Fictional authorization for offline test only',
    profile_hash: store.profile().hash, expires_at: new Date(Date.now() + 3600000).toISOString(), max_attempts_per_utc_day: limit } });
}

test('empty template blocks search and preserves user edits on re-init', t => {
  const f = fixture(t, false);
  assert.throws(() => f.store.runStart({}), /confirm profile/);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'policy.json'))).mode, 'review_each');
  f.profile.identity.name = 'Fictional candidate';
  writeFileSync(f.profilePath, JSON.stringify(f.profile));
  writeFileSync(join(f.dir, '.gitignore'), '*\n!keep-this-rule\n');
  initData(f.dir);
  assert.equal(JSON.parse(readFileSync(f.profilePath)).identity.name, 'Fictional candidate');
  assert.match(readFileSync(join(f.dir, '.gitignore'), 'utf8'), /keep-this-rule/);
});
test('canonical URL deduplication persists and reimport preserves draft status', t => {
  const { store, dir } = fixture(t);
  prepare(store);
  const r = store.runStart({});
  const x = vacancy(r, 'fictional-alias');
  x.url = 'https://example.invalid/fictional-a?utm_source=test#fragment';
  assert.equal(store.put(x).is_new, false);
  assert.equal(store.list().length, 1);
  assert.equal(store.job('fictional-alias').status, 'draft');
  const reopened = new Tracker(dir);
  assert.equal(reopened.list().length, 1);
  reopened.close();
});
test('full text is required to assess fit', t => {
  const { store } = fixture(t);
  const x = vacancy(store.runStart({}));
  delete x.description;
  assert.throws(() => store.put(x), /Read full vacancy/);
});
test('manual approval required and draft changes revoke approval', t => {
  const { store } = fixture(t);
  prepare(store);
  assert.throws(() => store.begin({ slug: 'fictional-a' }), /approval required/);
  store.approve({ slug: 'fictional-a', user_authorization: 'Synthetic individual yes' });
  store.prepare({ ...store.job('fictional-a').draft, cover_letter: 'Changed fictional letter' });
  assert.equal(store.job('fictional-a').approval, null);
  assert.throws(() => store.begin({ slug: 'fictional-a' }), /approval required/);
});
test('profile change invalidates existing approved packet', t => {
  const f = fixture(t);
  prepare(f.store);
  f.store.approve({ slug: 'fictional-a', user_authorization: 'Synthetic yes' });
  f.profile.identity.city = 'Fictional city';
  writeFileSync(f.profilePath, JSON.stringify(f.profile));
  assert.throws(() => f.store.begin({ slug: 'fictional-a' }), /stale/);
});
test('changed resume bytes block submission', t => {
  const { store, dir } = fixture(t);
  prepare(store);
  store.approve({ slug: 'fictional-a', user_authorization: 'Synthetic yes' });
  writeFileSync(join(dir, 'resumes', 'fictional.txt'), 'Changed');
  assert.throws(() => store.begin({ slug: 'fictional-a' }), /Resume file changed/);
});
test('external route produces handoff and cannot begin', t => {
  const { store } = fixture(t);
  prepare(store, 'fictional-a', 'external');
  assert.equal(store.job('fictional-a').status, 'needs_user');
  assert.throws(() => store.begin({ slug: 'fictional-a' }));
  store.status({ slug: 'fictional-a', status: 'submitted_external', note: 'Fictional user report' });
  assert.equal(store.job('fictional-a').status, 'submitted_external');
});
test('auto daily cap is shared between connections and survives restart', t => {
  const { store, dir } = fixture(t);
  prepare(store); prepare(store, 'fictional-b'); auto(store);
  store.begin({ slug: 'fictional-a' });
  const second = new Tracker(dir);
  try { assert.throws(() => second.begin({ slug: 'fictional-b' }), /daily attempt cap/); }
  finally { second.close(); }
  assert.equal(store.job('fictional-b').status, 'draft');
});
test('auto rejects unknown critical conditions and expiry', t => {
  const { store, dir } = fixture(t);
  prepare(store); auto(store);
  const r = store.runStart({});
  const v = vacancy(r); v.match.requirements[0].result = 'unknown';
  store.put(v);
  store.prepare({ ...store.job('fictional-a').draft });
  assert.throws(() => store.begin({ slug: 'fictional-a' }), /all critical requirements/);
  const policy = JSON.parse(readFileSync(join(dir, 'policy.json')));
  policy.auto.expires_at = '2000-01-01T00:00:00Z';
  writeFileSync(join(dir, 'policy.json'), JSON.stringify(policy));
  assert.throws(() => store.begin({ slug: 'fictional-a' }), /expired/);
});
test('dispatch passes literal arguments once, with durable duplicate guard', t => {
  const { store, dir } = fixture(t);
  prepare(store);
  store.approve({ slug: 'fictional-a', user_authorization: 'Synthetic yes' });
  const packet = store.begin({ slug: 'fictional-a' });
  let calls = 0;
  const fake = (data, args) => {
    calls++; assert.equal(args[6], packet.cover_letter); assert.equal(data, dir);
    return { status: 0, stdout: '{"fictional_success":true}', stderr: '' };
  };
  sendPacket(dir, packet, fake);
  assert.throws(() => sendPacket(dir, packet, fake), /UNIQUE/);
  assert.equal(calls, 1);
  assert.equal(store.job('fictional-a').status, 'submitting'); // Raw success is not invented confirmation.
  store.finish({ attempt_id: packet.attempt_id, outcome: 'submitted', application_id: 'fictional-1', evidence: 'Synthetic response, reviewed' });
  assert.throws(() => store.begin({ slug: 'fictional-a' }));
  assert.match(store.report().content, /submitted/);
  assert.ok(store.history().some(e => e.kind === 'send_result'));
});
test('timeout records uncertainty, blocks retry, permits evidence-based resolution', t => {
  const { store, dir } = fixture(t);
  prepare(store); auto(store);
  const packet = store.begin({ slug: 'fictional-a' });
  sendPacket(dir, packet, () => ({ status: null, error: new Error('Synthetic timeout') }));
  assert.equal(store.job('fictional-a').status, 'submission_unknown');
  assert.throws(() => store.begin({ slug: 'fictional-a' }));
  store.resolveUnknown({ slug: 'fictional-a', outcome: 'failed', evidence: 'Synthetic user confirmation: not sent' });
  assert.equal(store.job('fictional-a').status, 'failed');
  assert.throws(() => store.prepare({ slug: 'fictional-a' }), /cannot be drafted/);
});
test('auto revocation between intent and dispatch blocks network', t => {
  const { store, dir } = fixture(t);
  prepare(store); auto(store);
  const packet = store.begin({ slug: 'fictional-a' });
  store.policy({ mode: 'review_each' });
  let called = false;
  assert.throws(() => sendPacket(dir, packet, () => { called = true; }), /revoked/);
  assert.equal(called, false);
});
test('CLI report and run history work from a fresh process', t => {
  const { store, dir } = fixture(t);
  const run = store.runStart({ query: 'synthetic' });
  store.runEvent({ run_id: run.run_id, kind: 'preview', data: { count: 0 } });
  store.runFinish({ run_id: run.run_id, status: 'complete', reason: 'No fictional matches' });
  const cli = resolve('plugins/jobhunt-kit/scripts/tracker.mjs');
  const r = spawnSync(process.execPath, [cli, '--data', dir, 'report'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).content, /No fictional matches/);
});

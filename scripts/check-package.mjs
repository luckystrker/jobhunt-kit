import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('plugins/jobhunt-kit');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
const files = walk(root);
for (const file of files) {
  assert.ok(!/\.(sqlite|db|pdf|docx|zip)(-|$)/i.test(file), `Personal/runtime artifact in plugin: ${file}`);
  if (file.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
  if (file.endsWith('.md')) {
    const body = readFileSync(file, 'utf8');
    assert.ok(!body.includes('[TODO:'), `Unfinished scaffold: ${file}`);
    for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = m[1];
      if (/^(https?:|#)/.test(link)) continue;
      assert.ok(existsSync(resolve(dirname(file), link.split('#')[0])), `Broken link ${file}: ${link}`);
    }
  }
}
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const profile = load(join(root, 'templates/profile.json'));
assert.equal(profile.confirmed_at, null);
assert.equal(profile.hirify_profile_id, null);
assert.deepEqual(profile.search.roles, []);
assert.deepEqual(profile.evidence, []);
assert.ok(Object.values(profile.identity).every(v => v === null || Array.isArray(v) && v.length === 0));
assert.equal(load(join(root, 'templates/policy.json')).mode, 'review_each');
assert.equal(load(join(root, 'templates/policy.json')).auto, null);
const codex = load(join(root, '.codex-plugin/plugin.json'));
const claude = load(join(root, '.claude-plugin/plugin.json'));
assert.equal(codex.name, 'jobhunt-kit'); assert.equal(claude.name, codex.name);
assert.equal(codex.version, claude.version);
assert.equal(load('package.json').version, codex.version);
assert.equal(load('plugins/jobhunt-kit/package.json').version, codex.version);
assert.equal(load('.claude-plugin/marketplace.json').plugins[0].version, codex.version);
for (const name of ['profile', 'policy', 'vacancy', 'draft', 'finish', 'status']) {
  const schema = load(join(root, 'schemas', `${name}.schema.json`));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
}
for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
  const market = load(file);
  for (const plugin of market.plugins) {
    const source = typeof plugin.source === 'string' ? plugin.source : plugin.source.path;
    assert.ok(existsSync(resolve(source, '.codex-plugin/plugin.json')));
  }
}
const skills = readdirSync(join(root, 'skills'));
assert.equal(skills.length, 5);
for (const skill of skills) {
  const body = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
  assert.ok(body.startsWith('---\n') || body.startsWith('---\r\n'));
  assert.match(body, new RegExp(`name: ${skill}\\r?\\n`));
  assert.match(body, /description: .+/);
}
for (const folder of ['.', root]) {
  const pkg = load(join(folder, 'package.json'));
  const lock = load(join(folder, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/hirify-cli'].version, '0.4.5');
  assert.deepEqual(lock.packages[''].dependencies || lock.packages[''].devDependencies, pkg.dependencies || pkg.devDependencies);
}
for (const [source, asset] of [
  ['.gitignore', 'installer-assets/gitignore.txt'],
  ['package-lock.json', 'installer-assets/workspace-lock.json'],
  ['plugins/jobhunt-kit/package-lock.json', 'installer-assets/runtime-lock.json']
]) assert.ok(readFileSync(source).equals(readFileSync(asset)), `Installer asset drift: ${asset}`);
console.log(`PACKAGE_OK: ${skills.length} skills, ${files.length} plugin files, valid JSON, local links, empty profile, disabled auto, pinned dependency`);

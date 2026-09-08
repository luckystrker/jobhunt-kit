#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['bin', 'installer-assets', 'plugins/job-search', 'scripts', 'tests',
  'AGENTS.md', 'CLAUDE.md', 'PLAN.md', 'README.md', 'VERIFICATION.md', 'package.json',
  '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'];
function collect(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in template: ${path}`);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).filter(n => !['node_modules', '__pycache__', '.git'].includes(n))
    .flatMap(n => collect(join(path, n)));
}
function noSymlinks(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Destination contains a symlink: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function install(destination, { source = SOURCE, installDependencies = true } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const target = resolve(destination);
  source = resolve(source);
  if (target === source || !relative(source, target).startsWith('..')) throw new Error('Choose a destination outside the installer package');
  const files = new Map();
  for (const root of roots) for (const path of collect(join(source, root))) files.set(relative(source, path), path);
  // npm omits package-lock.json and may omit .gitignore; ship them under explicit asset names.
  files.set('.gitignore', join(source, 'installer-assets/gitignore.txt'));
  files.set('package-lock.json', join(source, 'installer-assets/workspace-lock.json'));
  files.set('plugins/job-search/package-lock.json', join(source, 'installer-assets/runtime-lock.json'));
  const pending = [];
  for (const [name, input] of files) {
    const output = join(target, name);
    noSymlinks(output);
    let parent = dirname(output);
    while (parent !== dirname(parent)) {
      if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Destination directory is a file: ${parent}`);
      parent = dirname(parent);
    }
    if (existsSync(output)) {
      if (!lstatSync(output).isFile() || !readFileSync(output).equals(readFileSync(input))) {
        throw new Error(`Existing file differs; nothing copied: ${output}. Choose an empty folder or keep your existing installation.`);
      }
    } else pending.push([input, output]);
  }
  for (const [input, output] of pending) {
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(input, output);
  }
  if (installDependencies) {
    const options = { cwd: target, stdio: 'inherit', windowsHide: true };
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'], options)
      : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    if (result.error || result.status !== 0) throw new Error(`Template copied to ${target}, but dependencies were not installed. Retry the same init command. ${result.error?.message || ''}`);
  }
  return { directory: target, copied: pending.length, dependencies_installed: installDependencies };
}
export function main(args) {
  if (args.length === 0 || ['--help', '-h'].includes(args[0])) {
    console.log('Usage: job-search init <directory>\nRequires Node.js 24+. Installs the template and Hirify CLI; does not log in, search or apply.');
    return;
  }
  if (args.length !== 2 || args[0] !== 'init' || !args[1]) throw new Error('Usage: job-search init <directory>');
  const result = install(args[1]);
  console.log(`\nJob Search ready: ${result.directory}\nCopied files: ${result.copied}\nOpen this folder in Codex or Claude Code and ask: use job-profile to initialize my profile.\nWhen needed, sign in yourself from that folder: npm run hirify -- login\nNo profile, schedule, search or application was created.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`job-search: ${e.message}`); process.exitCode = 1; }
}

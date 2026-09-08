#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

try {
  const [flag, data, install] = process.argv.slice(2);
  if (flag !== '--data' || !data || (install && install !== '--install-cli')) throw new Error('Usage: setup.mjs --data <directory> [--install-cli]');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (install) {
    // Install next to the bundle so ESM resolution is independent of ambient parent node_modules.
    const options = { cwd: root, stdio: 'inherit', windowsHide: true };
    const r = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'], options)
      : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    if (r.error || r.status !== 0) throw new Error(r.error?.message || 'npm ci failed; no sign-in or search was attempted');
    if (!existsSync(join(root, 'node_modules', 'ajv', 'package.json'))) throw new Error('npm ci completed without installing the local runtime dependencies');
  }
  const { initData } = await import('./tracker.mjs');
  const result = initData(data);
  console.log(JSON.stringify({ ...result, cli_install_requested: Boolean(install), authenticated: false }, null, 2));
} catch (e) { console.error(`jobhunt-kit: ${e.message}`); process.exitCode = 1; }

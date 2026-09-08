#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initData } from './tracker.mjs';

try {
  const [flag, data, install] = process.argv.slice(2);
  if (flag !== '--data' || !data || (install && install !== '--install-cli')) throw new Error('Usage: setup.mjs --data <directory> [--install-cli]');
  const result = initData(data);
  if (install) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const runtime = join(result.data, 'runtime');
    mkdirSync(runtime, { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(root, name), join(runtime, name));
    // Fixed arguments; npm on Windows is a .cmd launcher. User paths go via cwd, not shell text.
    const options = { cwd: runtime, stdio: 'inherit', windowsHide: true };
    const r = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'], options)
      : spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], options);
    if (r.error || r.status !== 0) throw new Error(r.error?.message || 'npm ci failed; no sign-in or search was attempted');
  }
  console.log(JSON.stringify({ ...result, cli_install_requested: Boolean(install), authenticated: false }, null, 2));
} catch (e) { console.error(`jobhunt-kit: ${e.message}`); process.exitCode = 1; }

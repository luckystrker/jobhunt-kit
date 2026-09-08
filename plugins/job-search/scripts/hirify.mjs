#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function cliPath(data) {
  let pkg = join(resolve(data), 'runtime', 'node_modules', 'hirify-cli', 'package.json');
  if (!existsSync(pkg)) {
    try { pkg = createRequire(import.meta.url).resolve('hirify-cli/package.json'); }
    catch { throw new Error('Hirify CLI missing. Run setup.mjs --data <directory> --install-cli'); }
  }
  const metadata = JSON.parse(readFileSync(pkg, 'utf8'));
  if (metadata.version !== '0.4.5') throw new Error('Expected hirify-cli 0.4.5; review compatibility before upgrading');
  return join(dirname(pkg), 'bin', 'hirify.js');
}
export function runCLI(data, args) {
  return spawnSync(process.execPath, [cliPath(data), ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [flag, data, ...args] = process.argv.slice(2);
    if (flag !== '--data' || !data || !args.length) throw new Error('Usage: hirify.mjs --data <directory> <Hirify arguments>');
    const r = runCLI(data, args);
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}

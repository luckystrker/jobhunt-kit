import { randomUUID, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_RESUME_BYTES = 20 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function inside(base, candidate) {
  const delta = relative(resolve(base), resolve(candidate));
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

export function assertNoSymlink(path, stop = dirname(resolve(path))) {
  let current = resolve(path);
  const boundary = resolve(stop);
  while (inside(boundary, current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed for local data: ${current}`);
    if (current === boundary) return;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Path escapes the expected data directory: ${path}`);
}

export function localPath(base, path) {
  if (typeof path !== 'string' || !path.trim() || isAbsolute(path)) throw new Error('Expected a relative path inside the local data directory');
  const output = resolve(base, path);
  if (!inside(base, output)) throw new Error(`Path escapes the local data directory: ${path}`);
  assertNoSymlink(output, base);
  return output;
}

export function readBytes(path, { maxBytes = MAX_JSON_BYTES, base = null } = {}) {
  const target = resolve(path);
  if (base) {
    if (!inside(base, target)) throw new Error(`Path escapes the local data directory: ${path}`);
    assertNoSymlink(target, base);
  } else if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Symbolic link input is not allowed: ${target}`);
  const stat = lstatSync(target);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${target}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} byte limit: ${target}`);
  return readFileSync(target);
}

export function readJSON(path, options = {}) {
  return JSON.parse(readBytes(path, options).toString('utf8').replace(/^\uFEFF/, ''));
}

export function atomicWrite(path, bytes, { base, mode = 0o600 } = {}) {
  const target = resolve(path);
  if (!base || !inside(base, target)) throw new Error(`Write target escapes the local data directory: ${target}`);
  assertNoSymlink(target, base);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  assertNoSymlink(dirname(target), base);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    renameSync(temporary, target);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function atomicWriteJSON(path, value, options) {
  atomicWrite(path, JSON.stringify(value, null, 2) + '\n', options);
}

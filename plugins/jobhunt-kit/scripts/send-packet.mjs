#!/usr/bin/env node
// Intentionally no retries. A durable dispatch record precedes the child process.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tracker } from './tracker.mjs';
import { cliPath, runCLI } from './hirify.mjs';

export function sendPacket(data, packet, transport = runCLI) {
  if (transport === runCLI) cliPath(data); // Diagnose missing executable before claiming dispatch.
  const tracker = new Tracker(data);
  try {
    tracker.dispatch(packet);
    try {
      const r = transport(data, ['vacancy', 'apply', packet.slug, '--profile', String(packet.hirify_profile_id), '--cover', packet.cover_letter, '--json']);
      // Raw response retained locally for the agent; no guessed vendor response schema.
      const output = { attempt_id: packet.attempt_id, exit_code: r.status ?? null,
        stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message || null };
      tracker.event('cli_response', output, tracker.job(packet.slug).id);
      if (r.error || r.status === null) tracker.finish({ attempt_id: packet.attempt_id, outcome: 'unknown', evidence: r.error?.message || 'Process ended without exit status' });
      return output;
    } catch (error) {
      tracker.finish({ attempt_id: packet.attempt_id, outcome: 'unknown', evidence: error.message });
      throw error;
    }
  } finally { tracker.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [flag, data, path] = process.argv.slice(2);
    if (flag !== '--data' || !data || !path) throw new Error('Usage: send-packet.mjs --data <directory> <packet.json>');
    const result = sendPacket(data, JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exit_code ?? 1;
  } catch (e) { console.error(`jobhunt-kit: ${e.message}`); process.exitCode = 1; }
}

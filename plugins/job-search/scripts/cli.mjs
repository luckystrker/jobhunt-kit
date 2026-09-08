#!/usr/bin/env node
// Portable plugin entry point, equivalent to the workflow commands in npx jobhunt-kit.
import { runCommand } from './commands.mjs';
try {
  const result = runCommand(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  if (result && Object.hasOwn(result, 'valid') && result.valid === false) process.exitCode = 1;
  if (result?.attempt_id && Object.hasOwn(result, 'exit_code')) process.exitCode = result.exit_code ?? 1;
} catch (error) { console.error(`job-search: ${error.message}`); process.exitCode = 1; }

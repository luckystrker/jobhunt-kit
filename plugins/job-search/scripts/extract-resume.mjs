#!/usr/bin/env node
// Parser subprocess: local bytes only, bounded by parent timeout/memory/output limits.
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

try {
  const [dir, file] = process.argv.slice(2);
  const local = join(resolve(dir), 'runtime', 'package.json');
  const bundled = createRequire(import.meta.url);
  const runtime = existsSync(local) ? createRequire(local) : bundled;
  const load = name => { try { return runtime(name); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return bundled(name); } };
  const bytes = readFileSync(file);
  let result;
  if (extname(file).toLowerCase() === '.pdf') {
    const { PDFParse } = load('pdf-parse');
    const parser = new PDFParse({ data: bytes, verbosity: 0, isEvalSupported: false });
    try {
      const parsed = await parser.getText();
      result = { method: 'pdf-parse', text: parsed.pages.map(p => p.text).join('\n\n'), pages: parsed.total, warnings: [] };
    } finally { await parser.destroy(); }
  } else if (extname(file).toLowerCase() === '.docx') {
    const parsed = await load('mammoth').extractRawText({ buffer: bytes });
    result = { method: 'mammoth', text: parsed.value, pages: null, warnings: parsed.messages.map(m => m.message) };
  } else throw new Error('Extractor supports PDF and DOCX');
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }

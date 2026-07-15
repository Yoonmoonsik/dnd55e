#!/usr/bin/env node
// Inserts a batch of translated entries into the target-language file,
// positioned by the english.xml order (the target must be an ordered
// subsequence of the EN file). Existing entries are copied byte for byte.
// Guards: unknown EN uid, uid already in FR, or version mismatch with EN
// abort the run — nothing is written.
//
// Usage: node tools/localization/loca-apply.mjs <batch.json> --lang <Language>
//   batch.json: [{ "contentuid": "...", "version": N, "text": "..." }, ...]
//   Texts must already be XML-escaped (&amp;, &lt;, &gt;) like the source.

import { readFileSync, writeFileSync } from 'node:fs';
import { EN_PATH, parseContentList, resolveTarget } from './loca-common.mjs';

const target = resolveTarget();

const batchPath = process.argv[2];
if (!batchPath) {
  console.error('Usage: node tools/localization/loca-apply.mjs <batch.json> --lang <Language>');
  process.exit(1);
}
const batch = JSON.parse(readFileSync(batchPath, 'utf8'));

const en = parseContentList(EN_PATH);
const fr = parseContentList(target.path);
if (en.duplicates.length || fr.duplicates.length) {
  console.error('Duplicate uids in source files — aborting.');
  process.exit(1);
}

const errors = [];
const batchMap = new Map();
for (const e of batch) {
  const enEntry = en.entries.get(e.contentuid);
  if (!enEntry) errors.push(`uid not in EN: ${e.contentuid}`);
  else if (enEntry.version !== e.version)
    errors.push(`version differs from EN (v${enEntry.version}): ${e.contentuid} v${e.version}`);
  if (fr.entries.has(e.contentuid)) errors.push(`uid already in target: ${e.contentuid}`);
  if (batchMap.has(e.contentuid)) errors.push(`duplicate uid in batch: ${e.contentuid}`);
  if (!e.text || !e.text.trim()) errors.push(`empty text: ${e.contentuid}`);
  batchMap.set(e.contentuid, e);
}
if (errors.length) {
  console.error('ERRORS — nothing written:');
  for (const err of errors) console.error(' -', err);
  process.exit(1);
}

const parts = [];
let inserted = 0;
for (const uid of en.order) {
  const existing = fr.entries.get(uid);
  if (existing) parts.push('  ' + existing.raw);
  else if (batchMap.has(uid)) {
    const e = batchMap.get(uid);
    parts.push(`  <content contentuid="${e.contentuid}" version="${e.version}">${e.text}</content>`);
    inserted++;
  }
}

const frXml = readFileSync(target.path, 'utf8');
writeFileSync(target.path, frXml.slice(0, frXml.indexOf('  <content ')) + parts.join('\n') + '\n</contentList>');
console.log(`${inserted} entry(ies) inserted into ${target.lang} (batch size: ${batch.length}).`);
if (inserted !== batch.length) {
  console.error('WARNING: some batch entries were not inserted.');
  process.exit(1);
}

#!/usr/bin/env node
// Updates EXISTING target-language entries: replaces the text and aligns
// the version attribute with english.xml.
// Guards: the uid must exist on both sides, and the entry must currently
// be stale (version EN > FR) unless --allow-same-version is passed (used for
// fixing entries whose version already matches).
//
// Usage: node tools/localization/loca-update.mjs <batch.json> --lang <Language> [--allow-same-version]
//   batch.json: [{ "contentuid": "...", "text": "..." }, ...]
//   (the target version is read from the EN file, not from the batch)

import { readFileSync, writeFileSync } from 'node:fs';
import { EN_PATH, parseContentList, resolveTarget } from './loca-common.mjs';

const target = resolveTarget();

const batchPath = process.argv[2];
const allowSame = process.argv.includes('--allow-same-version');
if (!batchPath) {
  console.error('Usage: node tools/localization/loca-update.mjs <batch.json> --lang <Language> [--allow-same-version]');
  process.exit(1);
}
const batch = JSON.parse(readFileSync(batchPath, 'utf8'));

const en = parseContentList(EN_PATH);
const fr = parseContentList(target.path);
let frXml = readFileSync(target.path, 'utf8');

const errors = [];
for (const e of batch) {
  const vEn = en.entries.get(e.contentuid)?.version;
  const vFr = fr.entries.get(e.contentuid)?.version;
  if (vEn === undefined) errors.push(`uid not in EN: ${e.contentuid}`);
  if (vFr === undefined) errors.push(`uid not in target: ${e.contentuid}`);
  if (vEn !== undefined && vFr !== undefined) {
    if (!allowSame && vEn <= vFr) errors.push(`not stale (EN v${vEn} / target v${vFr}): ${e.contentuid}`);
    if (allowSame && vEn < vFr) errors.push(`target version above EN: ${e.contentuid}`);
  }
  if (!e.text || !e.text.trim()) errors.push(`empty text: ${e.contentuid}`);
}
if (errors.length) {
  console.error('ERRORS — nothing written:');
  for (const err of errors) console.error(' -', err);
  process.exit(1);
}

let updated = 0;
for (const e of batch) {
  const vEn = en.entries.get(e.contentuid).version;
  const re = new RegExp(`<content contentuid="${e.contentuid}" version="\\d+"\\s*>[\\s\\S]*?</content>`);
  const replacement = `<content contentuid="${e.contentuid}" version="${vEn}">${e.text}</content>`;
  const before = frXml;
  frXml = frXml.replace(re, replacement);
  if (frXml === before) {
    console.error(`Replacement had no effect: ${e.contentuid}`);
    process.exit(1);
  }
  updated++;
}

writeFileSync(target.path, frXml);
console.log(`${updated} entry(ies) updated in ${target.lang}.`);

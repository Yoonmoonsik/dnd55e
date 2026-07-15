#!/usr/bin/env node
// Compares a target-language file against english.xml by contentuid:
//   a) contentuids missing from the target (with the EN text)
//   b) entries on both sides where version EN > target (stale translation)
//   c) target orphans (absent from EN — reported, never deleted silently)
// Usage: node tools/localization/loca-diff.mjs --lang <Language> [--out <report.json>] [--sample N]

import { writeFileSync } from 'node:fs';
import { EN_PATH, parseContentList, resolveTarget } from './loca-common.mjs';

const target = resolveTarget();

const args = { out: null, sample: 10 };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = process.argv[++i];
  else if (process.argv[i] === '--sample') args.sample = Number(process.argv[++i]);
}

const en = parseContentList(EN_PATH);
const fr = parseContentList(target.path);

const missingInFr = [];
const outdatedInFr = [];
const orphansInFr = [];

for (const [uid, e] of en.entries) {
  const f = fr.entries.get(uid);
  if (!f) missingInFr.push({ contentuid: uid, version: e.version, en: e.text });
  else if (e.version > f.version)
    outdatedInFr.push({ contentuid: uid, versionEn: e.version, versionFr: f.version, en: e.text, fr: f.text });
}
for (const [uid, f] of fr.entries) {
  if (!en.entries.has(uid)) orphansInFr.push({ contentuid: uid, version: f.version, fr: f.text });
}

const report = {
  counts: {
    en: en.entries.size,
    fr: fr.entries.size,
    missingInFr: missingInFr.length,
    outdatedInFr: outdatedInFr.length,
    orphansInFr: orphansInFr.length,
    duplicateUidsEn: en.duplicates.length,
    duplicateUidsFr: fr.duplicates.length,
  },
  duplicates: { en: en.duplicates, fr: fr.duplicates },
  missingInFr,
  outdatedInFr,
  orphansInFr,
};
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));

const trunc = (s, n = 100) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

console.log('=== Counts ===');
console.log(`EN total                 : ${report.counts.en}`);
console.log(`${target.lang} total`.padEnd(25) + `: ${report.counts.fr}`);
console.log(`(a) missing from target  : ${report.counts.missingInFr}`);
console.log(`(b) stale (v EN > target): ${report.counts.outdatedInFr}`);
console.log(`(c) target orphans       : ${report.counts.orphansInFr}`);
console.log(`duplicate uids EN/target : ${report.counts.duplicateUidsEn} / ${report.counts.duplicateUidsFr}`);

if (args.sample > 0) {
  console.log(`\n=== Sample (a) — ${Math.min(args.sample, missingInFr.length)} entries missing from target ===`);
  for (const e of missingInFr.slice(0, args.sample)) console.log(`- ${e.contentuid} (v${e.version}): ${trunc(e.en)}`);
  if (outdatedInFr.length) {
    console.log(`\n=== Sample (b) — ${Math.min(args.sample, outdatedInFr.length)} stale entries ===`);
    for (const e of outdatedInFr.slice(0, args.sample)) {
      console.log(`- ${e.contentuid} (EN v${e.versionEn} / target v${e.versionFr})`);
      console.log(`    EN: ${trunc(e.en)}`);
      console.log(`    FR: ${trunc(e.fr)}`);
    }
  }
  if (orphansInFr.length) {
    console.log(`\n=== Sample (c) — ${Math.min(args.sample, orphansInFr.length)} target orphans ===`);
    for (const e of orphansInFr.slice(0, args.sample)) console.log(`- ${e.contentuid} (v${e.version}): ${trunc(e.fr)}`);
  }
}

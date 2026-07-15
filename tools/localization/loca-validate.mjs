#!/usr/bin/env node
// Final validation of a target-language file against english.xml:
//   1. identical counts, no duplicate contentuid, no orphans
//   2. version aligned with EN for every entry
//   3. identical inline structure per entry: LSTag tags (by Tooltip), <br>,
//      entities, placeholders [1]..[9], paragraph count
//   4. identical dice (XdY) and number multisets per entry — French-only:
//      distances in metres are normalized back to feet before comparing
//      (the FR file uses BG3's metric convention, the EN source keeps feet)
// Usage: node tools/localization/loca-validate.mjs --lang <Language>

import { EN_PATH, parseContentList, resolveTarget } from './loca-common.mjs';

const target = resolveTarget();

const en = parseContentList(EN_PATH);
const fr = parseContentList(target.path);
const problems = [];

if (en.duplicates.length) problems.push(`duplicate uids in EN: ${en.duplicates.join(', ')}`);
if (fr.duplicates.length) problems.push(`duplicate uids in target: ${fr.duplicates.join(', ')}`);
for (const uid of en.entries.keys()) if (!fr.entries.has(uid)) problems.push(`missing from target: ${uid}`);
for (const uid of fr.entries.keys()) if (!en.entries.has(uid)) problems.push(`target orphan: ${uid}`);

const count = (s, re) => (s.match(re) ?? []).length;
const tooltipCounts = (s) => {
  const map = new Map();
  for (const m of s.matchAll(/Tooltip="([^"]+)"/g)) map.set(m[1], (map.get(m[1]) ?? 0) + 1);
  return map;
};
// Feet → metres conversion used by the French file (×0.3, longest match first).
const METRIC = [
  ['13,50 mètres', '45'], ['4,50 mètres', '15'], ['1,50 mètre', '5'],
  ['36 mètres', '120'], ['27 mètres', '90'], ['18 mètres', '60'],
  ['12 mètres', '40'], ['9 mètres', '30'], ['6 mètres', '20'],
  ['3 mètres', '10'], ['60 cm', '2'], ['30 cm', '1'],
];
const normalizeUnits = (s) => {
  if (target.lang !== 'French') return s;
  let t = s;
  for (const [metric, feet] of METRIC) t = t.split(metric).join(feet + ' ft');
  return t;
};
const stripNoise = (s) =>
  s.replace(/\d+d\d+/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/Tooltip="[^"]*"/g, ' ');
const numbers = (s) => (stripNoise(s).match(/\d+/g) ?? []).sort((a, b) => a - b).join(',');
const dice = (s) => (s.match(/\d+d\d+/g) ?? []).sort().join(',');

for (const [uid, e] of en.entries) {
  const f = fr.entries.get(uid);
  if (!f) continue;
  if (e.version !== f.version) {
    problems.push(`version differs (EN v${e.version} / target v${f.version}): ${uid}`);
    continue;
  }
  for (const [name, re] of [
    ['LSTag', /LSTag/g],
    ['br', /&lt;br&gt;/g],
    ['&amp;', /&amp;(?!lt;|gt;|amp;)/g],
    ['paragraphs', /\n\n/g],
  ]) {
    if (count(e.text, re) !== count(f.text, re))
      problems.push(`${name}: ${count(e.text, re)} EN vs ${count(f.text, re)} target — ${uid}`);
  }
  for (let n = 1; n <= 9; n++) {
    const re = new RegExp(`\\[${n}\\]`, 'g');
    if (count(e.text, re) !== count(f.text, re))
      problems.push(`placeholder [${n}]: ${count(e.text, re)} EN vs ${count(f.text, re)} target — ${uid}`);
  }
  const tEn = tooltipCounts(e.text);
  const tFr = tooltipCounts(f.text);
  for (const [k, v] of tEn) if ((tFr.get(k) ?? 0) !== v) problems.push(`Tooltip "${k}": ${v} EN vs ${tFr.get(k) ?? 0} target — ${uid}`);
  for (const k of tFr.keys()) if (!tEn.has(k)) problems.push(`Tooltip "${k}" only in target — ${uid}`);

  const fNorm = normalizeUnits(f.text);
  if (dice(e.text) !== dice(fNorm)) problems.push(`dice: [${dice(e.text)}] EN vs [${dice(fNorm)}] target — ${uid}`);
  if (numbers(e.text) !== numbers(fNorm)) problems.push(`numbers: [${numbers(e.text)}] EN vs [${numbers(fNorm)}] target — ${uid}`);
}

console.log(`EN: ${en.entries.size} entries | ${target.lang}: ${fr.entries.size} entries`);
if (!problems.length) {
  console.log('✅ FULL VALIDATION: no issues found.');
} else {
  console.log(`❌ ${problems.length} issue(s):`);
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}

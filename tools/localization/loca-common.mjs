// Shared helpers for the localization scripts.
// All scripts compare a target language against English and require
// `--lang <FolderName>`, e.g. `--lang French` or `--lang Korean`.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOCA_DIR = resolve(
  import.meta.dirname,
  '../..',
  'Mods/DnD2024_897914ef-5c96-053c-44af-0be823f895fe/Localization'
);
export const EN_PATH = resolve(LOCA_DIR, 'English/english.xml');

// Resolves a language folder to its XML file. Folder layouts vary
// (french.xml, korean.xml, DnD55eAllInOneBEYONDPTBR.xml…), so the single
// .xml file found in the folder is used.
export function resolveLangFile(lang) {
  const dir = resolve(LOCA_DIR, lang);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.xml'));
  } catch {
    console.error(`Unknown language folder: ${dir}`);
    process.exit(1);
  }
  if (files.length !== 1) {
    console.error(`Expected exactly one .xml in ${dir}, found ${files.length}.`);
    process.exit(1);
  }
  return { lang, path: resolve(dir, files[0]) };
}

// Extracts the mandatory --lang <FolderName> argument from argv (mutating).
export function resolveTarget(argv = process.argv) {
  const i = argv.indexOf('--lang');
  const lang = i !== -1 ? argv[i + 1] : null;
  if (!lang || lang.startsWith('--')) {
    console.error('Missing required argument: --lang <LanguageFolder> (e.g. --lang French)');
    process.exit(1);
  }
  argv.splice(i, 2);
  return resolveLangFile(lang);
}

export const ENTRY_RE = /<content contentuid="([^"]+)" version="(\d+)"\s*>([\s\S]*?)<\/content>/g;

// Parses a contentList XML. Texts may span multiple lines and contain
// escaped inline tags, hence the non-greedy dotAll match.
// Returns { entries: Map<uid, {version, text, raw, order}>, duplicates: uid[], order: uid[] }
export function parseContentList(path) {
  const xml = readFileSync(path, 'utf8');
  const entries = new Map();
  const duplicates = [];
  const order = [];
  let m;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(xml)) !== null) {
    const [raw, uid, version, text] = m;
    if (entries.has(uid)) {
      duplicates.push(uid);
      continue;
    }
    entries.set(uid, { version: Number(version), text, raw, order: order.length });
    order.push(uid);
  }
  return { entries, duplicates, order };
}

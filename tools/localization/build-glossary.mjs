#!/usr/bin/env node
// Builds tools/localization/glossary-french.json from the translations already established in
// french.xml (aligned with english.xml by contentuid).
// Two sources:
//   1. "terms": short paired entries (spell/feat/item names) -> direct EN/FR pair
//   2. "mechanics": game terms appearing inside descriptions; for each EN term
//      the co-occurring FR candidate is counted across aligned entries and the
//      majority translation wins.
// User-arbitrated decisions (USER_DECISIONS) override the automatic result.
// NOTE: this script is French-specific by nature (the mechanic seeds and
// decisions below are French); the approach is portable to other languages
// by swapping the seed lists.
// Usage: node tools/localization/build-glossary.mjs

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EN_PATH, parseContentList, resolveLangFile } from './loca-common.mjs';

const FR_PATH = resolveLangFile('French').path;

const OUT_PATH = resolve(import.meta.dirname, 'glossary-french.json');

const en = parseContentList(EN_PATH).entries;
const fr = parseContentList(FR_PATH).entries;

// --- 1. Direct pairs from short "term-like" entries -------------------------

function isTermLike(text) {
  return (
    text.length <= 60 &&
    !/[\n<>]/.test(text) &&
    !/[.!?]$/.test(text.trim()) &&
    text.split(/\s+/).length <= 8
  );
}

const terms = {};
const variants = new Map();
for (const [uid, e] of en) {
  const f = fr.get(uid);
  if (!f) continue;
  const enText = e.text.trim();
  const frText = f.text.trim();
  if (!isTermLike(enText) || !isTermLike(frText)) continue;
  if (!variants.has(enText)) variants.set(enText, new Map());
  const v = variants.get(enText);
  v.set(frText, (v.get(frText) ?? 0) + 1);
}

const conflicts = [];
for (const [enText, v] of variants) {
  const sorted = [...v.entries()].sort((a, b) => b[1] - a[1]);
  terms[enText] = { fr: sorted[0][0], count: sorted.reduce((s, [, c]) => s + c, 0) };
  if (sorted.length > 1) conflicts.push({ en: enText, variants: sorted.map(([f, count]) => ({ fr: f, count })) });
}

// --- 2. Inline mechanics, confirmed by corpus co-occurrence -----------------

const MECHANIC_SEEDS = [
  { en: 'Saving Throw', candidates: ['jet de sauvegarde', 'jets de sauvegarde'] },
  { en: 'Attack Roll', candidates: ["jet d'attaque", "jets d'attaque"] },
  { en: 'Advantage', candidates: ['Avantage'] },
  { en: 'Disadvantage', candidates: ['Désavantage'] },
  { en: 'Sneak Attack', candidates: ['Attaque sournoise'] },
  { en: 'Bardic Inspiration', candidates: ['Inspiration bardique'] },
  { en: 'Channel Divinity', candidates: ['Conduit divin', 'Canalisation divine'] },
  { en: 'Heroic Inspiration', candidates: ['Inspiration héroïque'] },
  { en: 'Wild Shape', candidates: ['Forme sauvage'] },
  { en: 'Spell Slot', candidates: ['emplacement de sort', 'emplacements de sort'] },
  { en: 'Cantrip', candidates: ['sort mineur', 'sorts mineurs', 'tour de magie', 'tours de magie'] },
  { en: 'Short Rest', candidates: ['repos court'] },
  { en: 'Long Rest', candidates: ['repos long'] },
  { en: 'Proficiency Bonus', candidates: ['bonus de maîtrise'] },
  { en: 'Proficiency', candidates: ['maîtrise'] },
  { en: 'Expertise', candidates: ['Expertise', 'Maîtrise approfondie'] },
  { en: 'Hit Points', candidates: ['points de vie', 'point de vie'] },
  { en: 'Temporary Hit Points', candidates: ['points de vie temporaires'] },
  { en: 'Hit Point Dice', candidates: ['Dés de points de vie', 'dés de vie', 'dé de vie'] },
  { en: 'Hit Die', candidates: ['dé de vie', 'dés de vie'] },
  { en: 'Armour Class', candidates: ["classe d'armure", 'CA'] },
  { en: 'Armor Class', candidates: ["classe d'armure", 'CA'] },
  { en: 'Difficult Terrain', candidates: ['terrain difficile'] },
  { en: 'Opportunity Attack', candidates: ["attaque d'opportunité", "attaques d'opportunité"] },
  { en: 'Concentration', candidates: ['Concentration'] },
  { en: 'Ritual', candidates: ['rituel'] },
  { en: 'Reaction', candidates: ['réaction'] },
  { en: 'Bonus Action', candidates: ['action bonus'] },
  { en: 'Movement Speed', candidates: ['vitesse de déplacement'] },
  { en: 'Darkvision', candidates: ['Vision dans le noir', 'Vision dans les ténèbres'] },
  { en: 'Resistance', candidates: ['Résistance'] },
  { en: 'Vulnerability', candidates: ['Vulnérabilité'] },
  { en: 'Immunity', candidates: ['Immunité', 'immunisé'] },
  { en: 'Initiative', candidates: ['Initiative'] },
  { en: 'Unarmed Strike', candidates: ['attaque à mains nues', 'frappe à mains nues'] },
  { en: 'Weapon Mastery', candidates: ["maîtrise d'arme", 'Maîtrise des armes'] },
  { en: 'Focus Point', candidates: ['point de focalisation', 'points de focalisation', 'point de ki', 'point de concentration'] },
  { en: 'Death Saving Throw', candidates: ['jet de sauvegarde contre la mort', 'jets de sauvegarde contre la mort', 'jet de mort', 'jets de mort'] },
  { en: 'Extra Attack', candidates: ['Attaque supplémentaire'] },
  { en: 'Spellcasting Ability', candidates: ["caractéristique d'incantation"] },
  { en: 'Spell Save DC', candidates: ['DD de sauvegarde'] },
  // Classes and species (mostly appear inline)
  { en: 'Barbarian', candidates: ['Barbare'] },
  { en: 'Bard', candidates: ['Barde'] },
  { en: 'Cleric', candidates: ['Clerc'] },
  { en: 'Druid', candidates: ['Druide'] },
  { en: 'Fighter', candidates: ['Guerrier'] },
  { en: 'Monk', candidates: ['Moine'] },
  { en: 'Paladin', candidates: ['Paladin'] },
  { en: 'Ranger', candidates: ['Rôdeur'] },
  { en: 'Rogue', candidates: ['Roublard'] },
  { en: 'Sorcerer', candidates: ['Ensorceleur'] },
  { en: 'Warlock', candidates: ['Occultiste', 'Sorcier'] },
  { en: 'Wizard', candidates: ['Magicien'] },
  { en: 'Artificer', candidates: ['Artificier'] },
  { en: 'Dwarf', candidates: ['Nain'] },
  { en: 'Elf', candidates: ['Elfe'] },
  { en: 'Halfling', candidates: ['Halfelin'] },
  { en: 'Tiefling', candidates: ['Tieffelin', 'Tiefelin'] },
  { en: 'Dragonborn', candidates: ['Drakéide', 'Né-du-dragon'] },
  { en: 'Half-Orc', candidates: ['Demi-orque', 'Demi-orc'] },
  { en: 'Orc', candidates: ['Orque'] },
  { en: 'Goliath', candidates: ['Goliath'] },
  { en: 'Aasimar', candidates: ['Aasimar'] },
  // Conditions (inline or as short entries)
  { en: 'Blinded', candidates: ['Aveuglé'] },
  { en: 'Charmed', candidates: ['Charmé'] },
  { en: 'Deafened', candidates: ['Assourdi'] },
  { en: 'Frightened', candidates: ['Effrayé'] },
  { en: 'Grappled', candidates: ['Agrippé', 'Empoigné'] },
  { en: 'Incapacitated', candidates: ['Neutralisé'] },
  { en: 'Paralyzed', candidates: ['Paralysé'] },
  { en: 'Petrified', candidates: ['Pétrifié'] },
  { en: 'Poisoned', candidates: ['Empoisonné'] },
  { en: 'Prone', candidates: ['À terre'] },
  { en: 'Restrained', candidates: ['Entravé'] },
  { en: 'Stunned', candidates: ['Étourdi'] },
  { en: 'Unconscious', candidates: ['Inconscient'] },
  { en: 'Exhaustion', candidates: ['Épuisement'] },
];

const alignedPairs = [];
for (const [uid, e] of en) {
  const f = fr.get(uid);
  if (f) alignedPairs.push({ uid, en: e.text, fr: f.text });
}

function countCooccurrence(enTerm, frCandidate) {
  const reEn = new RegExp(`\\b${enTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const frLower = frCandidate.toLowerCase();
  let enHits = 0;
  let both = 0;
  for (const p of alignedPairs) {
    if (!reEn.test(p.en)) continue;
    enHits++;
    if (p.fr.toLowerCase().includes(frLower)) both++;
  }
  return { enHits, both };
}

const mechanics = {};
const unresolved = [];
for (const seed of MECHANIC_SEEDS) {
  let enHits = 0;
  const scores = seed.candidates.map((c) => {
    const r = countCooccurrence(seed.en, c);
    enHits = r.enHits;
    return { fr: c, cooccurrences: r.both };
  });
  scores.sort((a, b) => b.cooccurrences - a.cooccurrences);
  if (enHits === 0) {
    unresolved.push({ en: seed.en, reason: 'term absent from aligned EN corpus' });
    continue;
  }
  if (scores[0].cooccurrences === 0) {
    unresolved.push({ en: seed.en, reason: `no candidate confirmed over ${enHits} EN hits`, candidates: seed.candidates });
    continue;
  }
  mechanics[seed.en] = {
    fr: scores[0].fr,
    evidence: `${scores[0].cooccurrences}/${enHits} aligned entries`,
    alternates: scores.slice(1).filter((s) => s.cooccurrences > 0),
  };
}

// --- Fallbacks for terms absent from the FR corpus --------------------------

const fallbacks = {
  Grappled: { fr: 'Agrippé', source: 'official 2024 French translation (absent from corpus)' },
  Petrified: { fr: 'Pétrifié', source: 'official 2024 French translation (absent from corpus)' },
  Deafened: { fr: 'Assourdi', source: 'official 2024 French translation (absent from corpus)' },
  Exhaustion: { fr: 'Épuisement', source: 'official 2024 French translation (absent from corpus)' },
  Halfling: { fr: 'Halfelin', source: 'BG3 base game (absent from corpus)' },
};

// --- User decisions (arbitrated 2026-07-15), applied on top -----------------

const USER_DECISIONS = {
  mechanics: {
    Cantrip: { fr: 'sort mineur', note: 'User decision: BG3 base-game term.' },
    Warlock: { fr: 'Occultiste', note: 'User decision: BG3 term; never "Sorcier-Lié"/"Sorcier".' },
    Expertise: { fr: 'Expertise', note: 'User decision: never "Maîtrise approfondie".' },
    'Weapon Mastery': {
      fr: "Maîtrise des armes / maîtrise d'arme",
      contextual: true,
      note: 'User decision: "Maîtrise des armes" as the feature name, "maîtrise d\'arme" inline.',
    },
    'Breath Weapon': {
      fr: 'Arme de souffle / arme du souffle',
      contextual: true,
      note: 'User decision: "Arme de souffle" = Dragonborn trait; "arme du souffle" = Druid Dragon Shape.',
    },
  },
  terms: {
    Guidance: { fr: 'Assistance', note: 'User decision: BG3 spell name.' },
    'Mage Slayer': { fr: 'Fléau des mages', note: 'User decision: BG3 feat name.' },
  },
};
for (const [k, d] of Object.entries(USER_DECISIONS.mechanics)) mechanics[k] = { ...(mechanics[k] ?? {}), ...d, decided: true };
for (const [k, d] of Object.entries(USER_DECISIONS.terms)) terms[k] = { ...(terms[k] ?? {}), ...d, decided: true };

// --- Output ------------------------------------------------------------------

const glossary = {
  _meta: {
    source: 'Extracted from the existing english.xml/french.xml pairs (aligned by contentuid).',
    rule: 'Terminology priority: BG3 base game > official French D&D translation > existing corpus > new translation.',
    generatedBy: 'tools/localization/build-glossary.mjs',
  },
  mechanics,
  mechanicsUnresolved: unresolved,
  fallbacks,
  terms,
  termConflicts: conflicts,
};
writeFileSync(OUT_PATH, JSON.stringify(glossary, null, 2));

console.log(`Glossary written to ${OUT_PATH}`);
console.log(`- terms (short EN/FR pairs)  : ${Object.keys(terms).length}`);
console.log(`- translation conflicts      : ${conflicts.length}`);
console.log(`- mechanics confirmed        : ${Object.keys(mechanics).length}`);
console.log(`- mechanics unresolved       : ${unresolved.length}`);

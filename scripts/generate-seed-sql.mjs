#!/usr/bin/env node
/**
 * Génère scripts/seed.sql à partir de englishWords.seed.final.json
 * Puis exécute : wrangler d1 execute englishfluency --remote --file=scripts/seed.sql
 *
 * Usage :
 *   node scripts/generate-seed-sql.mjs           # génère seed.sql
 *   node scripts/generate-seed-sql.mjs --local   # génère + exécute en local
 *   node scripts/generate-seed-sql.mjs --remote  # génère + exécute sur D1 remote
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cherche le JSON final dans appenglish ou apptechno
const CANDIDATES = [
  path.join(__dirname, '../../app-english/src/data/englishWords.seed.final.json'),
  path.join(__dirname, '../../../appenglish/app-english/src/data/englishWords.seed.final.json'),
];
const INPUT_FILE  = CANDIDATES.find(fs.existsSync);
const OUTPUT_FILE = path.join(__dirname, 'seed.sql');

const MODE = process.argv.includes('--remote') ? 'remote'
           : process.argv.includes('--local')  ? 'local'
           : null;

if (!INPUT_FILE) {
  console.error('❌ englishWords.seed.final.json introuvable');
  console.error('   Chemins testés :', CANDIDATES.join('\n   '));
  process.exit(1);
}

// ─── Helpers SQL ────────────────────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function escJson(val) {
  if (!val) return "'{}'";
  try {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    return `'${str.replace(/'/g, "''")}'`;
  } catch {
    return "'{}'";
  }
}

// ─── Normalisation ──────────────────────────────────────────────────────────
function normalizeNiveau(n) {
  if (n === 'B1-B2') return 'B2';
  return n ?? 'B1';
}

function normalizeWord(w) {
  return {
    id:             w.id,
    mot:            w.mot,
    type:           w.type ?? 'noun',
    niveau:         normalizeNiveau(w.niveau),
    traduction:     w.traduction ?? null,
    ipa_uk:         w.ipa_uk ?? null,
    ipa_us:         w.ipa_us ?? null,
    audio_uk:       w.audio_uk ?? '',
    audio_us:       w.audio_us ?? '',
    registre:       w.registre ?? 'neutral',
    faux_ami:       w.faux_ami ? 1 : 0,
    faux_ami_note:  w.faux_ami_note ?? null,
    frequence:      typeof w.frequence === 'number' ? w.frequence : 3,
    examples:       JSON.stringify(Array.isArray(w.examples) ? w.examples : []),
    synonymes:      JSON.stringify(Array.isArray(w.synonymes) ? w.synonymes : []),
    collocations:   JSON.stringify(Array.isArray(w.collocations) ? w.collocations : []),
    famille_de_mots: JSON.stringify(w.famille_de_mots ?? {}),
    tags:           JSON.stringify(Array.isArray(w.tags) ? w.tags : []),
  };
}

// ─── Génération SQL ─────────────────────────────────────────────────────────
function buildInsert(w) {
  const n = normalizeWord(w);
  return `INSERT INTO words (
  id, mot, type, niveau, traduction, ipa_uk, ipa_us,
  audio_uk, audio_us, registre, faux_ami, faux_ami_note, frequence,
  examples, synonymes, collocations, famille_de_mots, tags
) VALUES (
  ${esc(n.id)}, ${esc(n.mot)}, ${esc(n.type)}, ${esc(n.niveau)},
  ${esc(n.traduction)}, ${esc(n.ipa_uk)}, ${esc(n.ipa_us)},
  ${esc(n.audio_uk)}, ${esc(n.audio_us)}, ${esc(n.registre)},
  ${n.faux_ami}, ${esc(n.faux_ami_note)}, ${n.frequence},
  ${escJson(n.examples)}, ${escJson(n.synonymes)}, ${escJson(n.collocations)},
  ${escJson(n.famille_de_mots)}, ${escJson(n.tags)}
) ON CONFLICT(id) DO UPDATE SET
  mot = excluded.mot, type = excluded.type, niveau = excluded.niveau,
  traduction = excluded.traduction, ipa_uk = excluded.ipa_uk, ipa_us = excluded.ipa_us,
  registre = excluded.registre, faux_ami = excluded.faux_ami, faux_ami_note = excluded.faux_ami_note,
  frequence = excluded.frequence, examples = excluded.examples, synonymes = excluded.synonymes,
  collocations = excluded.collocations, famille_de_mots = excluded.famille_de_mots,
  tags = excluded.tags, updated_at = datetime('now');`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
console.log(`\n📖 Lecture de ${path.basename(INPUT_FILE)}...`);
const words = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
console.log(`   ${words.length} mots chargés`);

const lines = [
  '-- englishfluency seed — généré automatiquement',
  `-- Source : ${path.basename(INPUT_FILE)}`,
  `-- Date   : ${new Date().toISOString()}`,
  `-- Total  : ${words.length} mots`,
  '',
  ...words.map(buildInsert),
];

fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
const sizeKb = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
console.log(`✅ ${path.basename(OUTPUT_FILE)} généré (${sizeKb} KB, ${words.length} INSERT)`);

if (!MODE) {
  console.log('\nPour seeder :');
  console.log('  npm run seed:local   # D1 locale');
  console.log('  npm run seed:remote  # D1 Cloudflare');
  process.exit(0);
}

// ─── Exécution wrangler ──────────────────────────────────────────────────────
const flag = MODE === 'remote' ? '--remote' : '--local';
console.log(`\n🚀 wrangler d1 execute englishfluency ${flag} --file=scripts/seed.sql`);
console.log('   (peut prendre 1-2 minutes pour 4617 mots...)\n');

try {
  execSync(
    `wrangler d1 execute englishfluency ${flag} --file=${OUTPUT_FILE}`,
    { stdio: 'inherit', cwd: path.join(__dirname, '..') }
  );
  console.log('\n✅ Seed terminé !');
} catch {
  console.error('\n❌ wrangler d1 execute a échoué. Vérifie :');
  console.error('   - wrangler login (connexion Cloudflare)');
  console.error('   - La migration 0001 a bien été appliquée');
  console.error('   - npm run migrate:remote');
  process.exit(1);
}

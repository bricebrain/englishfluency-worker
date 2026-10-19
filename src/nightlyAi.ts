import {
  MODELS,
  NIGHTLY_NEURON_BUDGET,
  cleanString,
  extractJsonObject,
  runChat,
  usedNeuronsToday,
} from './aiBudget';
import { getOrCreateDaily } from './dailyContent';
import { indexSemanticBatch } from './semantic';
import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { validateEntry, type SourceRow } from './vocabularyEnrichment';
import { toVocabularyEnrichmentDto } from './vocabularyEnrichmentMapper';

/**
 * Tâches de nuit : le quota Workers AI est remis à zéro chaque jour, ce qui
 * n'est pas consommé est perdu. Le cron de nuit (toutes les 15 min, 0 h–6 h UTC)
 * enchaîne de petites tâches tant que la consommation estimée du jour reste
 * sous NIGHTLY_NEURON_BUDGET. Chaque passage reste court (limites des crons).
 */

const LINGVIST_SCHEMA_VERSION = 4;

// ── Régénération des cartes Lingvist « locales » ────────────────────────────

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    sentenceEn: { type: 'string' }, answer: { type: 'string' }, translationFr: { type: 'string' },
    grammarHintFr: { type: 'string' }, verbFormLabel: { type: 'string' },
  },
  required: ['sentenceEn', 'answer', 'translationFr', 'grammarHintFr'],
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RegeneratedCard {
  sentenceFull: string;
  expectedAnswer: string;
  sentenceWithGap: string;
  translationFr: string;
  grammarHint: string;
  verbFormLabel: string | null;
}

/** Valide une carte générée : la réponse figure dans la phrase et ressemble au mot. */
export function normalizeGeneratedCard(raw: unknown, lemma: string): RegeneratedCard | null {
  const data = extractJsonObject(raw);
  if (!data) return null;
  const sentenceFull = cleanString(data.sentenceEn, 220);
  const expectedAnswer = cleanString(data.answer, 40).replace(/[.,!?;:]+$/, '');
  const translationFr = cleanString(data.translationFr, 260);
  const words = sentenceFull.split(/\s+/).length;
  if (!sentenceFull || !expectedAnswer || !translationFr || words < 5 || words > 20) return null;
  // La forme attendue doit partager le début du lemme (évite qu'un autre mot soit visé).
  const stem = lemma.toLowerCase().slice(0, Math.max(3, Math.min(lemma.length - 1, 5)));
  if (!expectedAnswer.toLowerCase().startsWith(stem.slice(0, 3))) return null;
  const pattern = new RegExp(`\\b${escapeRegex(expectedAnswer)}\\b`, 'i');
  if (!pattern.test(sentenceFull)) return null;
  const sentenceWithGap = sentenceFull.replace(pattern, '____');
  return {
    sentenceFull,
    expectedAnswer,
    sentenceWithGap,
    translationFr,
    grammarHint: cleanString(data.grammarHintFr, 160) || 'Observe le contexte avant et après le trou.',
    verbFormLabel: cleanString(data.verbFormLabel, 40) || null,
  };
}

export async function regenerateLingvistCards(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.profile_id, c.word_id, c.lemma, c.target_pos, c.sentence_full,
           w.traduction, w.niveau, w.type, ve.data AS enrichment_data
    FROM lingvist_cards c
    JOIN words w ON w.id = c.word_id
    LEFT JOIN vocabulary_enrichments ve ON ve.word_id = w.id
    WHERE c.source = 'local' AND c.schema_version = ?
    ORDER BY c.updated_at ASC
    LIMIT ?
  `).bind(LINGVIST_SCHEMA_VERSION, limit).all<{
    id: string; profile_id: string; word_id: string; lemma: string; target_pos: string; sentence_full: string;
    traduction: string | null; niveau: string; type: string | null; enrichment_data: string | null;
  }>();

  let regenerated = 0;
  for (const card of results) {
    const enrichment = toVocabularyEnrichmentDto({ enrichment_data: card.enrichment_data });
    const translation = enrichment?.primaryTranslation || card.traduction || '';
    const raw = await runChat(env, MODELS.quality, [
      { role: 'system', content: 'Tu écris des phrases d’exercice de vocabulaire anglais pour un francophone. Réponds seulement en JSON valide.' },
      {
        role: 'user',
        content: [
          `Mot : "${card.lemma}" (${enrichment?.partOfSpeech || card.type || 'mot'}), sens : « ${translation} », niveau ${card.niveau}.`,
          'Écris une phrase anglaise naturelle de 8 à 16 mots, typique de la vie réelle, où ce mot dans ce sens est indispensable.',
          '"sentenceEn" : la phrase ; "answer" : la forme EXACTE du mot telle qu’elle apparaît dans la phrase ;',
          '"translationFr" : la traduction française fidèle de la phrase ;',
          '"grammarHintFr" : un indice court en français sur la forme attendue, sans donner le mot ;',
          '"verbFormLabel" : pour un verbe, la forme utilisée (base verbale, prétérit, participe passé, -ing, 3e personne), sinon "".',
        ].join('\n'),
      },
    ], { temperature: 0.5, maxTokens: 400, jsonSchema: CARD_SCHEMA });
    const generated = normalizeGeneratedCard(raw, card.lemma);
    if (!generated) continue;
    await env.DB.prepare(`
      UPDATE lingvist_cards SET
        example_en = ?, expected_answer = ?, sentence_with_gap = ?, sentence_full = ?, translation_fr = ?,
        word_traduction_fr = ?, grammar_hint = ?, verb_form_label = COALESCE(?, verb_form_label),
        source = 'remote', updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      generated.sentenceFull, generated.expectedAnswer, generated.sentenceWithGap, generated.sentenceFull,
      generated.translationFr, translation || null, generated.grammarHint,
      card.target_pos === 'verb' ? generated.verbFormLabel : null, card.id,
    ).run();
    regenerated += 1;
  }
  return regenerated;
}

// ── Brouillons d'enrichissement pour l'atelier Vocabulaire ──────────────────

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    lemma: { type: 'string' }, displayForm: { type: 'string' }, partOfSpeech: { type: 'string' },
    primaryTranslation: { type: 'string' },
    translationStatus: { type: 'string', enum: ['correct', 'incomplete', 'incorrect_as_standalone', 'incorrect', 'ambiguous'] },
    reviewNote: { type: 'string' },
    senses: {
      type: 'array',
      items: { type: 'object', properties: { senseKey: { type: 'string' }, partOfSpeech: { type: 'string' }, translation: { type: 'string' }, exampleEn: { type: 'string' }, exampleFr: { type: 'string' } }, required: ['senseKey', 'partOfSpeech', 'translation', 'exampleEn', 'exampleFr'] },
    },
    collocations: {
      type: 'array',
      items: { type: 'object', properties: { en: { type: 'string' }, fr: { type: 'string' }, kind: { type: 'string', enum: ['collocation', 'grammar_pattern', 'phrasal_verb', 'idiom', 'expression'] }, senseKey: { type: 'string' } }, required: ['en', 'fr', 'kind', 'senseKey'] },
    },
  },
  required: ['lemma', 'displayForm', 'partOfSpeech', 'primaryTranslation', 'translationStatus', 'senses', 'collocations'],
};

/** Construit une entrée au format de l'atelier, puis la valide comme le ferait la publication. */
export function buildDraftEntry(raw: unknown, source: SourceRow): { entry: Record<string, unknown>; errors: string[] } {
  const data = extractJsonObject(raw) ?? {};
  const entry = {
    id: source.id,
    originalWord: source.mot,
    originalTranslation: source.traduction ?? '',
    originalType: source.type,
    lemma: cleanString(data.lemma, 120),
    displayForm: cleanString(data.displayForm, 120),
    partOfSpeech: cleanString(data.partOfSpeech, 40),
    primaryTranslation: cleanString(data.primaryTranslation, 200),
    translationStatus: cleanString(data.translationStatus, 40),
    reviewRequired: true,
    reviewNote: cleanString(data.reviewNote, 300) || 'Brouillon généré la nuit par Workers AI, à vérifier.',
    senses: Array.isArray(data.senses) ? (data.senses as Record<string, unknown>[]).slice(0, 3) : [],
    collocations: Array.isArray(data.collocations) ? (data.collocations as Record<string, unknown>[]).slice(0, 4) : [],
  };
  return { entry, errors: validateEntry(entry, source) };
}

export async function generateEnrichmentDrafts(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(`
    SELECT w.id, w.mot, w.traduction, w.type, w.niveau
    FROM words w
    LEFT JOIN vocabulary_enrichments ve ON ve.word_id = w.id
    LEFT JOIN vocabulary_enrichment_drafts d ON d.word_id = w.id
    WHERE ve.word_id IS NULL AND d.word_id IS NULL
    ORDER BY w.frequence DESC, w.id
    LIMIT ?
  `).bind(limit).all<SourceRow>();
  let created = 0;
  for (const source of results) {
    const raw = await runChat(env, MODELS.quality, [
      { role: 'system', content: 'Tu es lexicographe anglais-français pour des apprenants francophones (A2–C1). Réponds seulement en JSON valide.' },
      {
        role: 'user',
        content: [
          `Mot source : "${source.mot}" — traduction actuelle : « ${source.traduction ?? ''} » — type : ${source.type} — niveau ${source.niveau}.`,
          '"lemma" : le lemme anglais sans « to » ; "displayForm" : forme d’affichage (« to + verbe » pour un verbe lexical, jamais pour un modal) ;',
          '"partOfSpeech" : noun, verb, adjective, adverb, preposition, phrasal_verb, modal_verb, expression ou other ;',
          '"primaryTranslation" : la meilleure traduction française autonome ; "translationStatus" : jugement de la traduction actuelle ;',
          '"senses" : 1 à 3 sens courants, chacun avec un senseKey en kebab-case, une traduction, un exemple anglais naturel et sa traduction ;',
          '"collocations" : 0 à 4 collocations ou structures utiles rattachées à un senseKey ; "reviewNote" : ce qu’un relecteur doit vérifier.',
        ].join('\n'),
      },
    ], { temperature: 0.2, maxTokens: 900, jsonSchema: DRAFT_SCHEMA });
    const { entry, errors } = buildDraftEntry(raw, source);
    if (errors.length) continue;
    await env.DB.prepare('INSERT OR REPLACE INTO vocabulary_enrichment_drafts (word_id, data, model, status) VALUES (?, ?, ?, \'draft\')')
      .bind(source.id, JSON.stringify(entry), MODELS.quality).run();
    created += 1;
  }
  return created;
}

export async function handleListEnrichmentDrafts(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const params = new URL(req.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50), 1), 50);
  const status = params.get('status') ?? 'draft';
  const { results } = await env.DB.prepare('SELECT word_id, data, model, status, created_at FROM vocabulary_enrichment_drafts WHERE status = ? ORDER BY created_at LIMIT ?')
    .bind(status, limit).all<{ word_id: string; data: string; model: string; status: string; created_at: string }>();
  return json({ items: results.map((row) => ({ ...row, data: JSON.parse(row.data) })), count: results.length });
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface NightlyReport {
  usedBefore: number;
  usedAfter: number;
  steps: Record<string, number | string>;
  stoppedOnBudget: boolean;
}

/** Une passe de nuit : petites tâches, arrêt dès que le budget du jour est atteint. */
export async function runNightlyAiPass(env: Env, budget = NIGHTLY_NEURON_BUDGET): Promise<NightlyReport> {
  const usedBefore = await usedNeuronsToday(env);
  const steps: Record<string, number | string> = {};
  let stoppedOnBudget = false;

  const tasks: [string, () => Promise<number | string>][] = [
    ['semanticIndexed', async () => (await indexSemanticBatch(env, 120)).indexed],
    ['dailyContent', async () => {
      const { results } = await env.DB.prepare('SELECT id FROM profiles').all<{ id: string }>();
      const profiles = results.length ? results.map((row) => row.id) : ['default'];
      let generated = 0;
      for (const profileId of profiles.slice(0, 3)) {
        for (const kind of ['sentences', 'story'] as const) {
          if ((await getOrCreateDaily(env, profileId, kind))?.generated) generated += 1;
        }
      }
      return generated;
    }],
    ['lingvistCards', () => regenerateLingvistCards(env, 5)],
    ['enrichmentDrafts', () => generateEnrichmentDrafts(env, 4)],
  ];

  for (const [name, task] of tasks) {
    if ((await usedNeuronsToday(env)) >= budget) {
      stoppedOnBudget = true;
      break;
    }
    try {
      steps[name] = await task();
    } catch (error) {
      steps[name] = `erreur: ${error instanceof Error ? error.message.slice(0, 120) : 'inconnue'}`;
    }
  }
  return { usedBefore, usedAfter: await usedNeuronsToday(env), steps, stoppedOnBudget };
}

export async function handleRunNightlyAi(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  return json(await runNightlyAiPass(env));
}

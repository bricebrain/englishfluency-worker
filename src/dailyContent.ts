import { MODELS, cleanString, cleanStringList, extractJsonObject, runChat, utcDay } from './aiBudget';
import type { Env } from './types';
import { err, json } from './utils';
import { toVocabularyEnrichmentDto } from './vocabularyEnrichmentMapper';

/**
 * Contenus générés par Workers AI à partir des mots à réviser :
 * - exercices « Construire des phrases » du jour ;
 * - histoire du jour qui réutilise ces mots ;
 * - questions de compréhension pour les scènes SRT qui n'en ont pas.
 * Générés la nuit (quota restant) ou à la demande, puis mis en cache en D1.
 */

export type DailyKind = 'sentences' | 'story';

export interface TargetWord {
  id: string;
  word: string;
  translation: string;
  level: string;
}

export interface SentenceExercise {
  prompt: string;
  expected: string;
  hint: string;
  distractors: string[];
  wordId: string;
}

export interface DailyStory {
  title: string;
  textEn: string;
  textFr: string;
  wordsUsed: string[];
  questions: { question: string; answer: string }[];
}

/** Mots à travailler : révisions dues ou fragiles d'abord, puis mots fréquents jamais vus. */
export async function loadTargetWords(env: Env, profileId: string, limit = 8): Promise<TargetWord[]> {
  const { results } = await env.DB.prepare(`
    SELECT w.id, w.mot, w.traduction, w.niveau, ve.data AS enrichment_data
    FROM word_progress wp
    JOIN words w ON w.id = wp.word_id
    LEFT JOIN vocabulary_enrichments ve ON ve.word_id = w.id
    WHERE wp.profile_id = ? AND wp.status != 'known'
    ORDER BY CASE WHEN wp.prochaine_revision <= datetime('now') THEN 0 ELSE 1 END,
             wp.fail_count DESC, wp.prochaine_revision ASC
    LIMIT ?
  `).bind(profileId, limit).all<{ id: string; mot: string; traduction: string | null; niveau: string; enrichment_data: string | null }>();
  let rows = results;
  if (rows.length < Math.min(4, limit)) {
    const { results: fresh } = await env.DB.prepare(`
      SELECT w.id, w.mot, w.traduction, w.niveau, ve.data AS enrichment_data
      FROM words w
      LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
      LEFT JOIN vocabulary_enrichments ve ON ve.word_id = w.id
      WHERE wp.id IS NULL AND w.niveau IN ('A2', 'B1', 'B2') AND w.frequence >= 3 AND w.mot NOT LIKE '% %'
      ORDER BY random()
      LIMIT ?
    `).bind(profileId, limit - rows.length).all<{ id: string; mot: string; traduction: string | null; niveau: string; enrichment_data: string | null }>();
    rows = [...rows, ...fresh];
  }
  return rows.map((row) => {
    const enrichment = toVocabularyEnrichmentDto({ enrichment_data: row.enrichment_data });
    return {
      id: row.id,
      word: enrichment?.lemma || row.mot,
      translation: enrichment?.primaryTranslation || row.traduction || '',
      level: row.niveau,
    };
  });
}

function wordsOf(sentence: string): string[] {
  return sentence.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter(Boolean);
}

const SENTENCES_SCHEMA = {
  type: 'object',
  properties: {
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string' }, expected: { type: 'string' }, hint: { type: 'string' },
          distractors: { type: 'array', items: { type: 'string' } }, word: { type: 'string' },
        },
        required: ['prompt', 'expected', 'hint', 'distractors', 'word'],
      },
    },
  },
  required: ['exercises'],
};

/** Valide les exercices générés ; ceux qui sont mal formés sont écartés. */
export function normalizeSentenceExercises(raw: unknown, targets: TargetWord[]): SentenceExercise[] {
  const data = extractJsonObject(raw);
  const items = Array.isArray(data?.exercises) ? data!.exercises as Record<string, unknown>[] : [];
  const byWord = new Map(targets.map((target) => [target.word.toLowerCase(), target.id]));
  const exercises: SentenceExercise[] = [];
  for (const item of items) {
    const prompt = cleanString(item?.prompt, 220);
    const expected = cleanString(item?.expected, 160).replace(/[.!?]+$/, '');
    const words = wordsOf(expected);
    if (!prompt || words.length < 3 || words.length > 16) continue;
    const distractors = cleanStringList(item?.distractors, 6, 24)
      .map((value) => value.replace(/[^A-Za-z'-]/g, ''))
      .filter((value) => value && !words.includes(value.toLowerCase()))
      .slice(0, 3);
    exercises.push({
      prompt,
      expected,
      hint: cleanString(item?.hint, 80),
      distractors,
      wordId: byWord.get(cleanString(item?.word, 60).toLowerCase()) ?? '',
    });
  }
  return exercises.slice(0, 8);
}

const STORY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, textEn: { type: 'string' }, textFr: { type: 'string' },
    questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] } },
  },
  required: ['title', 'textEn', 'textFr', 'questions'],
};

export function normalizeStory(raw: unknown, targets: TargetWord[]): DailyStory | null {
  const data = extractJsonObject(raw);
  if (!data) return null;
  const textEn = cleanString(data.textEn, 2500);
  const wordCount = wordsOf(textEn).length;
  if (wordCount < 60 || wordCount > 300) return null;
  const lower = textEn.toLowerCase();
  const questions = (Array.isArray(data.questions) ? data.questions as Record<string, unknown>[] : [])
    .map((item) => ({ question: cleanString(item?.question, 220), answer: cleanString(item?.answer, 300) }))
    .filter((item) => item.question && item.answer)
    .slice(0, 4);
  return {
    title: cleanString(data.title, 100) || 'Story of the day',
    textEn,
    textFr: cleanString(data.textFr, 3000),
    wordsUsed: targets.map((target) => target.word).filter((word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(lower)),
    questions,
  };
}

function targetList(targets: TargetWord[]) {
  return targets.map((target) => `- ${target.word} (${target.translation || 'sans traduction'}, ${target.level})`).join('\n');
}

async function generateSentences(env: Env, targets: TargetWord[]): Promise<SentenceExercise[]> {
  const raw = await runChat(env, MODELS.quality, [
    { role: 'system', content: 'Tu crées des exercices de traduction français → anglais pour un francophone de niveau B1. Réponds seulement en JSON valide.' },
    {
      role: 'user',
      content: [
        'Crée 6 exercices, chacun centré sur un mot différent de cette liste :',
        targetList(targets),
        'Pour chaque exercice, écris D’ABORD la phrase anglaise, PUIS traduis-la :',
        '- "expected" : une phrase anglaise naturelle et correcte de 5 à 12 mots qui utilise le mot dans son sens indiqué ;',
        '- "prompt" : la traduction française EXACTE de "expected" : même sens, même temps, mêmes quantités, rien d’ajouté ni d’enlevé ;',
        '- "hint" : le point de grammaire, très court, avec les termes des cours d’anglais en France',
        '  (Présent simple, Présent en be + -ing, Prétérit, Present perfect, Futur en will, Passif, Modal + base verbale…) ;',
        '- "distractors" : 3 mots anglais isolés qui sont des PIÈGES crédibles pour cette phrase : autre forme du même verbe',
        '  (has/had, win/won), préposition ou article voisin (at/on, a/the), faux ami ou mot proche ; jamais un mot sans rapport ;',
        '- "word" : le mot de la liste utilisé.',
      ].join('\n'),
    },
  ], { temperature: 0.3, maxTokens: 1400, jsonSchema: SENTENCES_SCHEMA });
  return keepFaithfulPairs(env, normalizeSentenceExercises(raw, targets));
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: { faithful: { type: 'array', items: { type: 'integer' } } },
  required: ['faithful'],
};

/**
 * Second contrôle par un autre modèle : ne garde que les paires où le français
 * est une traduction fidèle de l'anglais (sinon l'exercice serait faux).
 */
async function keepFaithfulPairs(env: Env, exercises: SentenceExercise[]): Promise<SentenceExercise[]> {
  if (!exercises.length) return exercises;
  const list = exercises.map((exercise, index) => `${index + 1}. FR: ${exercise.prompt}\n   EN: ${exercise.expected}`).join('\n');
  const raw = await runChat(env, MODELS.fast, [
    { role: 'system', content: 'Tu vérifies des traductions. Réponds seulement en JSON valide.' },
    {
      role: 'user',
      content: `Pour chaque paire, la phrase anglaise est-elle une traduction fidèle de la phrase française (même sens, même temps, mêmes quantités) ?\n${list}\nRenvoie {"faithful":[numéros des paires fidèles]}.`,
    },
  ], { temperature: 0, maxTokens: 120, jsonSchema: VERIFY_SCHEMA });
  const data = extractJsonObject(raw);
  if (!data || !Array.isArray(data.faithful)) return exercises; // contrôle indisponible : on garde
  const keep = new Set((data.faithful as unknown[]).map(Number).filter(Number.isInteger));
  return exercises.filter((_, index) => keep.has(index + 1));
}

async function generateStory(env: Env, targets: TargetWord[]): Promise<DailyStory | null> {
  const raw = await runChat(env, MODELS.quality, [
    { role: 'system', content: 'Tu écris de courtes histoires en anglais pour un francophone de niveau B1. Réponds seulement en JSON valide.' },
    {
      role: 'user',
      content: [
        'Écris une histoire du quotidien de 120 à 170 mots, en anglais simple et naturel (niveau B1),',
        'qui utilise le plus possible de ces mots :',
        targetList(targets),
        '"title" : un titre anglais court ; "textEn" : l’histoire ; "textFr" : sa traduction française ;',
        '"questions" : 3 questions de compréhension en anglais avec leur réponse courte en anglais.',
      ].join('\n'),
    },
  ], { temperature: 0.7, maxTokens: 1600, jsonSchema: STORY_SCHEMA });
  return normalizeStory(raw, targets);
}

/** Contenu du jour : depuis le cache D1, sinon généré puis mis en cache. */
export async function getOrCreateDaily(env: Env, profileId: string, kind: DailyKind, day = utcDay()): Promise<{ payload: unknown; generated: boolean } | null> {
  const cached = await env.DB.prepare('SELECT payload FROM generated_exercises WHERE profile_id = ? AND day = ? AND kind = ?')
    .bind(profileId, day, kind).first<{ payload: string }>();
  if (cached) return { payload: JSON.parse(cached.payload), generated: false };

  const targets = await loadTargetWords(env, profileId, kind === 'story' ? 8 : 10);
  if (!targets.length) return null;
  const payload = kind === 'sentences'
    ? { day, targets: targets.map((target) => target.word), exercises: await generateSentences(env, targets) }
    : await generateStory(env, targets).then((story) => story ? { day, ...story } : null);
  if (!payload || ('exercises' in payload && payload.exercises.length < 3)) return null;

  await env.DB.prepare(`
    INSERT INTO generated_exercises (profile_id, day, kind, payload, model) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, day, kind) DO NOTHING
  `).bind(profileId, day, kind, JSON.stringify(payload), MODELS.quality).run();
  return { payload, generated: true };
}

export async function handleDailyExercises(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const profileId = params.get('profileId') ?? 'default';
  const kind = params.get('kind');
  if (kind !== 'sentences' && kind !== 'story') return err('kind doit valoir sentences ou story');
  try {
    const result = await getOrCreateDaily(env, profileId, kind);
    if (!result) return json({ error: 'Contenu indisponible' }, 503);
    return json({ kind, ...result });
  } catch (error) {
    console.warn('exercises/daily', error instanceof Error ? error.message : error);
    return err('Génération indisponible', 502);
  }
}

// ── Questions de compréhension des scènes SRT ───────────────────────────────

const QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] } },
  },
  required: ['questions'],
};

export function normalizeQuestions(raw: unknown): { question: string; answer: string }[] {
  const data = extractJsonObject(raw);
  return (Array.isArray(data?.questions) ? data!.questions as Record<string, unknown>[] : [])
    .map((item) => ({ question: cleanString(item?.question, 220), answer: cleanString(item?.answer, 300) }))
    .filter((item) => item.question && item.answer)
    .slice(0, 3);
}

/** Génère les questions de `limit` scènes SRT qui n'en ont pas. */
export async function generateSrtQuestions(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(`
    SELECT sc.id, sc.text, sc.level FROM srt_scenes sc
    LEFT JOIN srt_scene_questions q ON q.scene_id = sc.id
    WHERE q.scene_id IS NULL
    ORDER BY sc.episode_id, sc.scene_index
    LIMIT ?
  `).bind(limit).all<{ id: string; text: string; level: string }>();
  let created = 0;
  for (const scene of results) {
    const raw = await runChat(env, MODELS.fast, [
      { role: 'system', content: 'Tu crées des questions de compréhension en anglais sur une scène de série. Réponds seulement en JSON valide.' },
      { role: 'user', content: `Scène (niveau ${scene.level}) :\n"""${cleanString(scene.text, 1800)}"""\nÉcris 2 questions en anglais dont la réponse est dans la scène, avec une réponse courte en anglais.` },
    ], { temperature: 0.3, maxTokens: 400, jsonSchema: QUESTIONS_SCHEMA });
    const questions = normalizeQuestions(raw);
    if (!questions.length) continue;
    await env.DB.prepare('INSERT OR REPLACE INTO srt_scene_questions (scene_id, questions_json, model) VALUES (?, ?, ?)')
      .bind(scene.id, JSON.stringify(questions), MODELS.fast).run();
    created += 1;
  }
  return created;
}

/** Questions déjà générées pour une liste de scènes. */
export async function loadSceneQuestions(env: Env, sceneIds: string[]): Promise<Map<string, { question: string; answer: string }[]>> {
  const map = new Map<string, { question: string; answer: string }[]>();
  for (let start = 0; start < sceneIds.length; start += 90) {
    const chunk = sceneIds.slice(start, start + 90);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT scene_id, questions_json FROM srt_scene_questions WHERE scene_id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk).all<{ scene_id: string; questions_json: string }>();
    results.forEach((row) => {
      try { map.set(row.scene_id, JSON.parse(row.questions_json)); } catch { /* ignorée */ }
    });
  }
  return map;
}

import type { Env } from './types';
import {
  buildSpeakingPromptPlan,
  matchGrammarPattern,
  pickCourseLessonId,
  SIGNAL_META,
  SIGNAL_RULES,
} from './learningPath';
import { err, isAuthorized, json } from './utils';

type LearningModule = 'review' | 'lingvist' | 'speak' | 'read' | 'listen' | 'course';
type LearningSkill = 'vocabulary' | 'speaking' | 'reading' | 'listening' | 'grammar';
type LearningEventType =
  | 'review_word'
  | 'speak_completed'
  | 'article_completed'
  | 'podcast_completed'
  | 'lesson_completed'
  | 'expression_reinforced'
  | 'roadmap_step_completed'
  | 'word_marked_known';

interface LearningEventBody {
  profileId: string;
  module: LearningModule;
  eventType: LearningEventType;
  skill: LearningSkill;
  contentId?: string;
  score?: number;
  durationSec?: number;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

interface CountRow {
  count: number;
}

interface DailyCountRow {
  day: string;
  count: number;
}

interface GroupedEventRow {
  module: LearningModule;
  event_count: number;
  avg_score: number | null;
}

interface LearningEventRow {
  event_type: LearningEventType;
  module: LearningModule;
  occurred_at: string;
  payload: string;
  score: number | null;
}

interface LearningWeakness {
  id: string;
  label: string;
  source: LearningSkill | LearningModule;
  confidence: number;
  recommendation: string;
  lessonId?: string | null;
}

interface LearningBridgeAction {
  badge: string;
  id: string;
  route: string;
  title: string;
}

interface LearningBridge {
  actions: LearningBridgeAction[];
  sourceLabel: string;
  summary: string;
  title: string;
}

interface LearningRecyclingItem {
  badge: string;
  id: string;
  module: 'read' | 'listen' | 'speak';
  occurredAt: string;
  promotedCount: number;
  route: string;
  title: string;
}

interface LearningRecycledExpression {
  expressionKey: string;
  id: string;
  isReinforced: boolean;
  lingvistRoute: string;
  module: 'read' | 'listen' | 'speak';
  occurredAt: string;
  practiceRoute: string;
  reinforcedAt: string | null;
  route: string;
  sourceTitle: string;
  term: string;
}

interface ProfileLearningGuidance {
  course: {
    focusArea: string;
    reason: string;
    recommendedLessonId: string | null;
    weaknessLabel: string | null;
    weaknessSource: LearningSkill | LearningModule | null;
  };
  speaking: {
    coachHint: string;
    focusArea: 'pronunciation' | 'fluency' | 'accuracy' | 'activation';
    preferredExerciseType: 'repeat' | 'respond';
    prompt: string;
    promptLabel: string | null;
  };
}

interface WeeklyPath {
  status: 'rising' | 'steady' | 'fragile';
  title: string;
  summary: string;
  focusLabel: string;
  progressLabel: string;
  targetLabel: string;
  coachTitle: string;
  coachMessage: string;
  actions: Array<{
    badge: string;
    id: string;
    route: string;
    subtitle: string;
    title: string;
  }>;
}

interface RecoveryPlan {
  title: string;
  summary: string;
  actions: Array<{
    badge: string;
    id: string;
    route: string;
    subtitle: string;
    title: string;
  }>;
}

interface WeeklyRoadmapDay {
  id: string;
  completedAt: string | null;
  dayLabel: string;
  status: 'done' | 'today' | 'focus' | 'next' | 'light';
  title: string;
  summary: string;
  route: string;
  badge: string;
}

interface PedagogicalProfile {
  mode: 'recover' | 'consolidate' | 'activate' | 'expand';
  title: string;
  diagnosis: string;
  evidence: string[];
  learningLoop: {
    currentStep: 'input' | 'comprehension' | 'memory' | 'activation' | 'correction';
    nextStep: 'review' | 'read' | 'listen' | 'speak' | 'course';
    rationale: string;
  };
  llmUse: {
    recommended: boolean;
    task: 'none' | 'speaking_feedback' | 'course_explanation' | 'content_comprehension' | 'coach_synthesis';
    reason: string;
  };
}

const MODULE_ROUTE_MAP: Record<LearningModule | 'learn', string> = {
  course: '/courses',
  learn: '/review?mode=new',
  lingvist: '/lingvist',
  listen: '/ecouter',
  read: '/lire',
  review: '/review?mode=due',
  speak: '/parler',
};

function isoNow(): string {
  return new Date().toISOString();
}

function makeEventId(profileId: string): string {
  return `${profileId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeEventCount(rows: GroupedEventRow[], module: LearningModule): number {
  return rows.find((row) => row.module === module)?.event_count ?? 0;
}

function lastDailyCount(rows: DailyCountRow[], day: string): number {
  return rows.find((row) => row.day === day)?.count ?? 0;
}

function safeAverage(rows: GroupedEventRow[], module: LearningModule): number | null {
  const value = rows.find((row) => row.module === module)?.avg_score;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function collectPayloadTexts(payload: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const scalarKeys = ['aiFeedback', 'explanation', 'grammarTopic', 'feedback', 'note'];

  for (const key of scalarKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      texts.push(value.trim());
    }
  }

  const commonMistakes = payload.commonMistakes;
  if (Array.isArray(commonMistakes)) {
    for (const item of commonMistakes) {
      if (typeof item === 'string' && item.trim()) {
        texts.push(item.trim());
      }
    }
  }

  return texts;
}

function extractSignalsFromPayload(payload: Record<string, unknown>): string[] {
  const explicitSignals = Array.isArray(payload.linguisticSignals)
    ? (payload.linguisticSignals as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  const corpus = [...explicitSignals, ...collectPayloadTexts(payload)].join(' ').trim();
  if (!corpus) return explicitSignals;

  const inferredSignals = SIGNAL_RULES
    .filter((rule) => rule.pattern.test(corpus))
    .map((rule) => rule.id);

  return [...new Set([...explicitSignals, ...inferredSignals])];
}

function clampConfidence(value: number): number {
  return Math.max(0.35, Math.min(0.98, Number(value.toFixed(2))));
}

function buildSpeakingRoute(mode: 'repeat' | 'respond', prompt: string): string {
  const encodedPrompt = encodeURIComponent(prompt);
  return `/parler?mode=${mode}&prompt=${encodedPrompt}`;
}

function normalizeExpressionPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function buildExpressionKey(module: 'read' | 'listen' | 'speak', sourceTitle: string, term: string): string {
  return `${module}:${normalizeExpressionPart(sourceTitle)}:${normalizeExpressionPart(term)}`;
}

function buildRecentRecyclingItems(events: LearningEventRow[]): LearningRecyclingItem[] {
  const items: LearningRecyclingItem[] = [];

  for (const event of events) {
    if (event.event_type !== 'article_completed' && event.event_type !== 'podcast_completed' && event.event_type !== 'speak_completed') {
      continue;
    }

    const payload = parsePayload(event.payload);
    const promotedCountRaw =
      typeof payload.promotedCount === 'number'
        ? payload.promotedCount
        : typeof payload.promotedVocabularyCount === 'number'
          ? payload.promotedVocabularyCount
          : 0;
    const promotedCount = Math.max(0, Math.round(promotedCountRaw));

    if (promotedCount <= 0) continue;

    if (event.event_type === 'article_completed') {
      items.push({
        badge: 'Lecture',
        id: `recycle_${event.module}_${event.occurred_at}`,
        module: 'read',
        occurredAt: event.occurred_at,
        promotedCount,
        route: '/lire',
        title: String(payload.articleTitle ?? payload.title ?? 'Lecture recente').trim(),
      });
      continue;
    }

    if (event.event_type === 'podcast_completed') {
      items.push({
        badge: 'Ecoute',
        id: `recycle_${event.module}_${event.occurred_at}`,
        module: 'listen',
        occurredAt: event.occurred_at,
        promotedCount,
        route: '/ecouter',
        title: String(payload.podcastTitle ?? payload.articleTitle ?? 'Podcast du jour').trim(),
      });
      continue;
    }

    items.push({
      badge: 'Parler',
      id: `recycle_${event.module}_${event.occurred_at}`,
      module: 'speak',
      occurredAt: event.occurred_at,
      promotedCount,
      route: '/parler',
      title: String(payload.prompt ?? 'Prise orale').trim().slice(0, 96),
    });
  }

  return items.slice(0, 8);
}

function buildRecentRecycledExpressions(events: LearningEventRow[]): LearningRecycledExpression[] {
  const items: LearningRecycledExpression[] = [];
  const seen = new Set<string>();
  const reinforcementMap = new Map<string, string>();

  for (const event of events) {
    if (event.event_type !== 'expression_reinforced') continue;

    const payload = parsePayload(event.payload);
    const expressionKey = typeof payload.expressionKey === 'string' ? payload.expressionKey.trim() : '';
    if (!expressionKey) continue;

    const current = reinforcementMap.get(expressionKey);
    if (!current || current < event.occurred_at) {
      reinforcementMap.set(expressionKey, event.occurred_at);
    }
  }

  for (const event of events) {
    if (event.event_type !== 'article_completed' && event.event_type !== 'podcast_completed' && event.event_type !== 'speak_completed') {
      continue;
    }

    const payload = parsePayload(event.payload);

    if (event.event_type === 'article_completed') {
      const sourceTitle = String(payload.articleTitle ?? payload.title ?? 'Lecture recente').trim();
      const terms = Array.isArray(payload.vocabularyTerms)
        ? (payload.vocabularyTerms as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];

      for (const term of terms.slice(0, 5)) {
        const expressionKey = buildExpressionKey('read', sourceTitle, term);
        if (seen.has(expressionKey)) continue;
        seen.add(expressionKey);
        const reinforcedAt = reinforcementMap.get(expressionKey) ?? null;
        items.push({
          expressionKey,
          id: `expr_${encodeURIComponent(expressionKey)}`,
          isReinforced: Boolean(reinforcedAt && reinforcedAt >= event.occurred_at),
          lingvistRoute: '/lingvist',
          module: 'read',
          occurredAt: event.occurred_at,
          practiceRoute: buildSpeakingRoute('respond', `Use "${term}" in 2 short sentences about "${sourceTitle}".`),
          reinforcedAt,
          route: '/lire',
          sourceTitle,
          term,
        });
      }
      continue;
    }

    if (event.event_type === 'podcast_completed') {
      const sourceTitle = String(payload.podcastTitle ?? payload.articleTitle ?? 'Podcast du jour').trim();
      const terms = Array.isArray(payload.keyVocab)
        ? (payload.keyVocab as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];

      for (const term of terms.slice(0, 5)) {
        const expressionKey = buildExpressionKey('listen', sourceTitle, term);
        if (seen.has(expressionKey)) continue;
        seen.add(expressionKey);
        const reinforcedAt = reinforcementMap.get(expressionKey) ?? null;
        items.push({
          expressionKey,
          id: `expr_${encodeURIComponent(expressionKey)}`,
          isReinforced: Boolean(reinforcedAt && reinforcedAt >= event.occurred_at),
          lingvistRoute: '/lingvist',
          module: 'listen',
          occurredAt: event.occurred_at,
          practiceRoute: buildSpeakingRoute('repeat', term),
          reinforcedAt,
          route: '/ecouter',
          sourceTitle,
          term,
        });
      }
      continue;
    }

    const sourceTitle = String(payload.prompt ?? 'Prise orale').trim().slice(0, 96);
    const terms = Array.isArray(payload.promotedExpressions)
      ? (payload.promotedExpressions as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];

    for (const term of terms.slice(0, 4)) {
      const expressionKey = buildExpressionKey('speak', sourceTitle, term);
      if (seen.has(expressionKey)) continue;
      seen.add(expressionKey);
      const reinforcedAt = reinforcementMap.get(expressionKey) ?? null;
      items.push({
        expressionKey,
        id: `expr_${encodeURIComponent(expressionKey)}`,
        isReinforced: Boolean(reinforcedAt && reinforcedAt >= event.occurred_at),
        lingvistRoute: '/lingvist',
        module: 'speak',
        occurredAt: event.occurred_at,
        practiceRoute: buildSpeakingRoute(term.split(/\s+/).length <= 6 ? 'repeat' : 'respond', term.split(/\s+/).length <= 6 ? term : `Reuse "${term}" in a short answer connected to "${sourceTitle}".`),
        reinforcedAt,
        route: '/parler',
        sourceTitle,
        term,
      });
    }
  }

  return items.slice(0, 12);
}

function deriveBridge(params: {
  recentEvents: LearningEventRow[];
  preferredExerciseType: 'repeat' | 'respond';
}): LearningBridge | null {
  const latestContentEvent = params.recentEvents.find((event) =>
    event.event_type === 'article_completed' || event.event_type === 'podcast_completed',
  );

  if (!latestContentEvent) return null;

  const payload = parsePayload(latestContentEvent.payload);

  if (latestContentEvent.event_type === 'article_completed') {
    const articleTitle = String(payload.articleTitle ?? payload.title ?? 'ta lecture recente').trim();
    const grammarPattern = String(payload.grammarPattern ?? '').trim();
    const lessonLabel = grammarPattern || 'le point utile du texte';
    const prompt = `Summarize what you learned from "${articleTitle}" and reuse ${lessonLabel} in your answer.`;

    return {
      title: 'Relancer depuis ta lecture',
      sourceLabel: articleTitle,
      summary: `Tu viens de lire un contenu utile. Le meilleur enchainement maintenant est de reutiliser ${lessonLabel.toLowerCase()} dans une prise orale courte.`,
      actions: [
        {
          id: 'bridge_review',
          title: 'Revoir les mots',
          badge: 'SRS',
          route: '/review?mode=new',
        },
        {
          id: 'bridge_speak',
          title: 'En parler a l oral',
          badge: params.preferredExerciseType === 'repeat' ? 'Shadowing' : 'Reemploi',
          route: buildSpeakingRoute(params.preferredExerciseType, prompt),
        },
      ],
    };
  }

  const podcastTitle = String(payload.podcastTitle ?? payload.articleTitle ?? 'le podcast du jour').trim();
  const keyVocab = Array.isArray(payload.keyVocab)
    ? (payload.keyVocab as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 3)
    : [];
  const vocabHint = keyVocab.length > 0 ? ` using ${keyVocab.join(', ')}` : '';
  const prompt = `Summarize the podcast "${podcastTitle}" in 2 or 3 sentences${vocabHint}.`;

  return {
    title: 'Passer de l ecoute a la parole',
    sourceLabel: podcastTitle,
    summary: 'Ton oreille a deja travaille. Le meilleur pont maintenant est une reformulation orale tres courte pour fixer les idees et le vocabulaire.',
    actions: [
      {
        id: 'bridge_listen',
        title: 'Refaire une ecoute',
        badge: 'Audio',
        route: '/ecouter',
      },
      {
        id: 'bridge_speak',
        title: 'Le reformuler',
        badge: params.preferredExerciseType === 'repeat' ? 'Guidé' : 'Libre',
        route: buildSpeakingRoute(params.preferredExerciseType, prompt),
      },
    ],
  };
}

function buildWeeklyPath(params: {
  bridge: LearningBridge | null;
  dueCount: number;
  focusSkill: LearningSkill;
  primaryAction: {
    badge: string;
    id: string;
    minutes: number;
    route: string;
    subtitle: string;
    title: string;
  };
  readSessions7d: number;
  listenSessions7d: number;
  reviewEvents7d: number;
  reviewedToday: number;
  speakAvgScore7d: number | null;
  speakSessions7d: number;
  supportingActions: Array<{
    badge: string;
    id: string;
    minutes: number;
    route: string;
    subtitle: string;
    title: string;
  }>;
  weaknesses: LearningWeakness[];
  weeklyActiveDays: number;
}): WeeklyPath {
  const topWeakness = params.weaknesses[0] ?? null;
  const balancedInput = params.readSessions7d > 0 && params.listenSessions7d > 0;
  const activeSpeaking = params.speakSessions7d > 0 && (params.speakAvgScore7d ?? 0) >= 0.62;
  const status: WeeklyPath['status'] =
    params.weeklyActiveDays <= 2 || params.dueCount >= 20
      ? 'fragile'
      : params.weeklyActiveDays >= 5 && balancedInput && activeSpeaking && params.reviewEvents7d >= 4
        ? 'rising'
        : 'steady';

  const title =
    status === 'fragile'
      ? 'Remettre la semaine sous controle'
      : status === 'rising'
        ? 'Capitaliser sur la bonne dynamique'
        : 'Stabiliser le rythme et l equilibre';

  const focusLabel = topWeakness?.label
    ?? (params.focusSkill === 'speaking'
      ? 'Reactivation orale'
      : params.focusSkill === 'reading'
        ? 'Lecture en contexte'
        : params.focusSkill === 'listening'
          ? 'Ecoute active'
          : 'Consolidation du vocabulaire');

  const summary =
    status === 'fragile'
      ? `La semaine manque encore de regularite. L'objectif est de remettre d'abord ${focusLabel.toLowerCase()} sous controle avant d'ajouter du volume.`
      : status === 'rising'
        ? `Ta semaine est bien orientee. Le meilleur levier maintenant est de prolonger ${focusLabel.toLowerCase()} sans casser la cadence.`
        : `Le rythme tient, mais il faut encore mieux ancrer ${focusLabel.toLowerCase()} pour transformer l'effort en progression visible.`;
  const coachTitle =
    status === 'fragile'
      ? 'On repart simple'
      : status === 'rising'
        ? 'Tu peux appuyer'
        : 'Continue sans te disperser';
  const coachMessage =
    status === 'fragile'
      ? 'Pas besoin de compenser par une grosse session. Deux ou trois blocs courts bien choisis suffisent pour relancer la semaine.'
      : status === 'rising'
        ? 'La dynamique est bonne. Garde surtout le mix review + oral + un contenu en contexte pour transformer l effort en progression durable.'
        : 'La semaine tient. Le vrai gain vient maintenant de la regularite et du reemploi, pas de la surcharge.';

  const progressLabel = `${params.weeklyActiveDays}/7 jours actifs`;
  const targetLabel =
    status === 'fragile'
      ? 'Cible: 4 jours actifs + 1 bloc oral'
      : status === 'rising'
        ? 'Cible: 5+ jours actifs en gardant lecture, ecoute et oral'
        : 'Cible: 4 a 5 jours actifs avec une meilleure boucle de reemploi';

  const actions = [
    params.primaryAction,
    ...params.supportingActions,
    ...(params.bridge?.actions.length
      ? params.bridge.actions.slice(0, 1).map((action) => ({
        badge: action.badge,
        id: action.id,
        route: action.route,
        subtitle: params.bridge?.summary ?? 'Recyclage utile depuis ton dernier contenu.',
        title: action.title,
      }))
      : []),
  ].slice(0, 3);

  return {
    actions,
    coachMessage,
    coachTitle,
    focusLabel,
    progressLabel,
    status,
    summary,
    targetLabel,
    title,
  };
}

function buildRecoveryPlan(params: {
  activeDays7d: number;
  bridge: LearningBridge | null;
  dueCount: number;
  focusSkill: LearningSkill;
  primaryAction: WeeklyPath['actions'][number];
  supportingActions: WeeklyPath['actions'];
  weeklyPath: WeeklyPath;
}): RecoveryPlan | null {
  if (params.weeklyPath.status !== 'fragile') return null;

  const actions = [
    params.primaryAction,
    ...params.supportingActions.filter((action) => action.route !== params.primaryAction.route),
    ...(params.bridge?.actions.length
      ? params.bridge.actions.slice(0, 1).map((action) => ({
        badge: action.badge,
        id: action.id,
        route: action.route,
        subtitle: params.bridge?.summary ?? 'Reutilise ton dernier contenu utile.',
        title: action.title,
      }))
      : []),
  ].slice(0, 3);

  const summary =
    params.dueCount >= 18
      ? `${params.activeDays7d}/7 jours actifs seulement et ${params.dueCount} cartes dues: on repart sur une petite boucle propre avant de chercher plus de volume.`
      : `${params.activeDays7d}/7 jours actifs seulement: l'objectif est de remettre un rythme simple, sans surcharge, pendant 2 ou 3 jours.`;

  const title =
    params.focusSkill === 'speaking'
      ? "Plan de rattrapage oral"
      : params.focusSkill === 'reading' || params.focusSkill === 'listening'
        ? "Plan de rattrapage immersion"
        : 'Plan de rattrapage du socle';

  return {
    actions,
    summary,
    title,
  };
}

function buildWeeklyRoadmap(params: {
  bridge: LearningBridge | null;
  completionEvents: LearningEventRow[];
  focusSkill: LearningSkill;
  primaryAction: WeeklyPath['actions'][number];
  supportingActions: WeeklyPath['actions'];
  weeklyPath: WeeklyPath;
}): WeeklyRoadmapDay[] {
  const formatter = new Intl.DateTimeFormat('fr-FR', { weekday: 'short' });
  const today = new Date();
  const routeFallback = {
    reading: '/lire',
    listening: '/ecouter',
    speaking: '/parler',
    vocabulary: '/lingvist',
    grammar: '/courses',
  } as const;
  const completionMap = new Map<string, string>();

  for (const event of params.completionEvents) {
    if (event.event_type !== 'roadmap_step_completed') continue;
    const payload = parsePayload(event.payload);
    const roadmapStepId = typeof payload.roadmapStepId === 'string' ? payload.roadmapStepId : '';
    if (!roadmapStepId) continue;
    const current = completionMap.get(roadmapStepId);
    if (!current || current < event.occurred_at) {
      completionMap.set(roadmapStepId, event.occurred_at);
    }
  }

  const cycle = [
    params.primaryAction,
    ...params.supportingActions,
    ...(params.bridge?.actions.length
      ? params.bridge.actions.map((action) => ({
        badge: action.badge,
        id: action.id,
        route: action.route,
        subtitle: params.bridge?.summary ?? 'Recyclage utile depuis ton dernier contenu.',
        title: action.title,
      }))
      : []),
    {
      badge: params.focusSkill === 'grammar' ? 'Cours' : 'Focus',
      id: 'weekly_focus',
      route: routeFallback[params.focusSkill],
      subtitle: `Bloc cible sur ${params.weeklyPath.focusLabel.toLowerCase()}.`,
      title: `Consolider ${params.weeklyPath.focusLabel.toLowerCase()}`,
    },
    {
      badge: 'Bilan',
      id: 'weekly_check',
      route: '/statistics',
      subtitle: 'Verifier la cadence, les cartes dues et les signaux faibles.',
      title: 'Faire un point de progression',
    },
  ];

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today);
    day.setDate(today.getDate() + index);
    const dateKey = day.toISOString().slice(0, 10);
    const action = cycle[index % cycle.length];
    const roadmapStepId = `${dateKey}:${action.id}`;
    const completedAt = completionMap.get(roadmapStepId) ?? null;
    const status: WeeklyRoadmapDay['status'] =
      completedAt
        ? 'done'
        : index === 0
          ? 'today'
          : index === 1 || index === 2
            ? 'focus'
            : index <= 4
              ? 'next'
              : 'light';

    return {
      badge: action.badge,
      completedAt,
      dayLabel: formatter.format(day),
      id: roadmapStepId,
      route: action.route,
      status,
      summary: action.subtitle,
      title: action.title,
    };
  });
}

function buildPedagogicalProfile(params: {
  bridge: LearningBridge | null;
  dueCount: number;
  focusSkill: LearningSkill;
  listenSessions7d: number;
  readSessions7d: number;
  reviewEvents7d: number;
  reviewedToday: number;
  speakAvgScore7d: number | null;
  speakSessions7d: number;
  weaknesses: LearningWeakness[];
  weeklyActiveDays: number;
}): PedagogicalProfile {
  const topWeakness = params.weaknesses[0] ?? null;
  const evidence: string[] = [];

  if (params.dueCount > 0) evidence.push(`${params.dueCount} cartes a revoir`);
  if (params.reviewEvents7d > 0) evidence.push(`${params.reviewEvents7d} actions memoire / 7j`);
  if (params.speakSessions7d > 0) evidence.push(`${params.speakSessions7d} sessions orales / 7j`);
  if (params.readSessions7d > 0) evidence.push(`${params.readSessions7d} lectures / 7j`);
  if (params.listenSessions7d > 0) evidence.push(`${params.listenSessions7d} ecoutes / 7j`);
  if (topWeakness) evidence.push(`signal dominant: ${topWeakness.label}`);

  const lowConsistency = params.weeklyActiveDays <= 2 || params.dueCount >= 20;
  const needsActivation = params.speakSessions7d === 0 || (params.speakAvgScore7d ?? 1) < 0.62;
  const hasInput = params.readSessions7d > 0 || params.listenSessions7d > 0 || Boolean(params.bridge);

  const mode: PedagogicalProfile['mode'] =
    lowConsistency
      ? 'recover'
      : needsActivation
        ? 'activate'
        : params.dueCount > 8 || topWeakness
          ? 'consolidate'
          : 'expand';

  const title =
    mode === 'recover'
      ? 'Reprendre sans surcharge'
      : mode === 'activate'
        ? 'Transformer le passif en oral'
        : mode === 'consolidate'
          ? 'Stabiliser le point fragile'
          : 'Elargir avec du contenu utile';

  const diagnosis =
    mode === 'recover'
      ? 'La priorite pedagogique est de remettre une boucle courte et fiable avant d ajouter de la difficulte.'
      : mode === 'activate'
        ? 'Le systeme voit assez de matiere pour travailler, mais il faut maintenant la faire sortir activement a l oral.'
        : mode === 'consolidate'
          ? `Le meilleur gain vient d une correction ciblee${topWeakness ? ` sur ${topWeakness.label.toLowerCase()}` : ''}, puis d un reemploi rapide.`
          : 'La base est assez stable pour ajouter un peu d input et enrichir ton stock actif.';

  const currentStep: PedagogicalProfile['learningLoop']['currentStep'] =
    params.dueCount > 12
      ? 'memory'
      : needsActivation
        ? 'activation'
        : topWeakness?.lessonId
          ? 'correction'
          : hasInput
            ? 'comprehension'
            : 'input';

  const nextStep: PedagogicalProfile['learningLoop']['nextStep'] =
    mode === 'recover'
      ? 'review'
      : needsActivation
        ? 'speak'
        : topWeakness?.lessonId
          ? 'course'
          : params.focusSkill === 'listening'
            ? 'listen'
            : params.focusSkill === 'reading'
              ? 'read'
              : 'speak';

  const rationale =
    nextStep === 'review'
      ? 'La memoire doit redevenir disponible avant de produire plus.'
      : nextStep === 'speak'
        ? 'La comprehension ne devient fluency que si elle est reutilisee dans une phrase personnelle.'
        : nextStep === 'course'
          ? 'Une explication ciblee est plus rentable qu une nouvelle activite aleatoire.'
          : nextStep === 'listen'
            ? 'Un nouvel input audio nourrit la comprehension et les patterns naturels.'
            : 'Une lecture guidee donne du contexte avant le recyclage.';

  const llmTask: PedagogicalProfile['llmUse']['task'] =
    nextStep === 'speak'
      ? 'speaking_feedback'
      : nextStep === 'course'
        ? 'course_explanation'
        : nextStep === 'read' || nextStep === 'listen'
          ? 'content_comprehension'
          : mode === 'recover'
            ? 'none'
            : 'coach_synthesis';

  return {
    diagnosis,
    evidence: evidence.slice(0, 5),
    learningLoop: {
      currentStep,
      nextStep,
      rationale,
    },
    llmUse: {
      recommended: llmTask !== 'none',
      task: llmTask,
      reason: llmTask === 'none'
        ? 'Pas besoin de LLM pour une remise en route simple: une action courte suffit.'
        : 'Le LLM est utile ici pour corriger, expliquer ou personnaliser le reemploi, pas seulement generer du contenu.',
    },
    mode,
    title,
  };
}

function deriveWeaknesses(params: {
  dueCount: number;
  recentEvents: LearningEventRow[];
  reviewAvgScore7d: number | null;
  speakAvgScore7d: number | null;
}): LearningWeakness[] {
  const weaknesses: LearningWeakness[] = [];

  const recentArticleMiss = params.recentEvents.find((event) => {
    if (event.event_type !== 'article_completed') return false;
    const payload = parsePayload(event.payload);
    return payload.correct === false && typeof payload.grammarPattern === 'string';
  });

  if (recentArticleMiss) {
    const payload = parsePayload(recentArticleMiss.payload);
    const grammarPattern = String(payload.grammarPattern ?? '').trim();
    const mapping = grammarPattern ? matchGrammarPattern(grammarPattern) : null;
    weaknesses.push({
      id: `grammar:${mapping?.lessonId ?? grammarPattern}`,
      label: mapping?.label ?? (grammarPattern || 'Structure grammaticale fragile'),
      source: 'reading',
      confidence: clampConfidence(0.72),
      recommendation: `Reprends une lecon ciblee sur ${mapping?.label ?? grammarPattern.toLowerCase()} pour stabiliser ce schema en contexte.`,
      lessonId: mapping?.lessonId ?? null,
    });
  }

  const signalCounts = new Map<string, { count: number; source: 'review' | 'lingvist' }>();
  const grammarTopics = new Map<string, { count: number; lessonId: string | null; label: string }>();

  for (const event of params.recentEvents) {
    if (event.event_type !== 'review_word' || (event.score ?? 1) > 0.72) continue;
    const payload = parsePayload(event.payload);
    const signals = extractSignalsFromPayload(payload);
    const sourceModule =
      payload.sourceModule === 'lingvist' || event.module === 'lingvist'
        ? 'lingvist'
        : 'review';

    for (const signal of signals) {
      const entry = signalCounts.get(signal) ?? { count: 0, source: sourceModule };
      entry.count += 1;
      if (sourceModule === 'lingvist') {
        entry.source = 'lingvist';
      }
      signalCounts.set(signal, entry);
    }

    if (typeof payload.grammarTopic === 'string' && payload.grammarTopic.trim()) {
      const grammarTopic = payload.grammarTopic.trim();
      const mapping = matchGrammarPattern(grammarTopic);
      const entry = grammarTopics.get(grammarTopic) ?? {
        count: 0,
        label: mapping?.label ?? grammarTopic,
        lessonId: mapping?.lessonId ?? null,
      };
      entry.count += 1;
      grammarTopics.set(grammarTopic, entry);
    }
  }

  for (const [signal, metaCount] of signalCounts.entries()) {
    const meta = SIGNAL_META[signal];
    if (!meta || metaCount.count < 2) continue;
    weaknesses.push({
      id: `signal:${signal}`,
      label: meta.label,
      source: metaCount.source,
      confidence: clampConfidence(0.58 + (metaCount.count * 0.08)),
      recommendation: meta.recommendation,
      lessonId: meta.lessonId,
    });
  }

  for (const [topic, meta] of grammarTopics.entries()) {
    if (meta.count < 2) continue;
    weaknesses.push({
      id: `grammar-topic:${topic}`,
      label: meta.label,
      source: 'grammar',
      confidence: clampConfidence(0.62 + (meta.count * 0.07)),
      recommendation: `Ce point revient souvent dans les erreurs recentes. Une remise a plat sur ${meta.label.toLowerCase()} devrait rapporter vite.`,
      lessonId: meta.lessonId,
    });
  }

  if (params.dueCount >= 12 || (params.reviewAvgScore7d ?? 1) < 0.68) {
    weaknesses.push({
      id: 'vocabulary-retention',
      label: 'Retention vocabulaire',
      source: 'vocabulary',
      confidence: clampConfidence(params.dueCount >= 20 ? 0.9 : 0.7),
      recommendation: 'Consolide d abord les cartes dues avant de chercher plus de volume ou plus de complexite.',
      lessonId: null,
    });
  }

  if ((params.speakAvgScore7d ?? 1) < 0.56) {
    weaknesses.push({
      id: 'speaking-pronunciation',
      label: 'Prononciation et rythme',
      source: 'speaking',
      confidence: clampConfidence(0.82),
      recommendation: 'Repete des structures courtes et propres avant de repasser sur des reponses plus longues.',
      lessonId: null,
    });
  } else if ((params.speakAvgScore7d ?? 1) < 0.72) {
    weaknesses.push({
      id: 'speaking-fluency',
      label: 'Fluidite orale',
      source: 'speaking',
      confidence: clampConfidence(0.7),
      recommendation: 'Travaille des reponses courtes mais completes pour gagner en enchainement naturel.',
      lessonId: null,
    });
  }

  return weaknesses
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

function buildGuidance(params: {
  focusSkill: LearningSkill;
  courseWeakness?: LearningWeakness | null;
  level: string | null | undefined;
  speakAvgScore7d: number | null;
  speakSessions7d: number;
  dueCount: number;
  newCount: number;
  weaknesses: LearningWeakness[];
}): ProfileLearningGuidance {
  const lessonId = pickCourseLessonId({
    focusSkill: params.focusSkill,
    grammarLessonId: params.courseWeakness?.lessonId ?? null,
    level: params.level,
    speakAvgScore7d: params.speakAvgScore7d,
  });
  const lowSpeakingScore = (params.speakAvgScore7d ?? 0) > 0 && (params.speakAvgScore7d ?? 0) < 0.62;
  const preferredExerciseType =
    params.speakSessions7d === 0 || lowSpeakingScore ? 'repeat' : 'respond';
  const speakingFocusArea: ProfileLearningGuidance['speaking']['focusArea'] =
    (params.speakAvgScore7d ?? 0) < 0.56
      ? 'pronunciation'
      : (params.speakAvgScore7d ?? 0) < 0.72
        ? 'fluency'
        : params.focusSkill === 'speaking'
          ? 'accuracy'
          : 'activation';
  const topWeakness = params.weaknesses[0] ?? null;

  let courseReason = 'Une lecon ciblee aidera a mieux reemployer ce que tu as vu cette semaine.';
  let courseFocusArea = 'Renforcement transversal';
  if (params.courseWeakness) {
    courseReason = `Le signal le plus net du moment concerne ${params.courseWeakness.label.toLowerCase()}. Une lecon ciblee devrait lever ce blocage rapidement.`;
    courseFocusArea = params.courseWeakness.label;
  } else if (params.focusSkill === 'vocabulary') {
    courseReason = params.dueCount > 0
      ? 'Ton stock est utile, mais il faut le rendre plus stable et plus naturel.'
      : 'Le bon levier maintenant est de renforcer les associations de vocabulaire.';
    courseFocusArea = 'Retention et collocations';
  } else if (params.focusSkill === 'speaking') {
    courseReason = lowSpeakingScore
      ? 'Ton oral a surtout besoin de structures tres sures avant de chercher plus de longueur.'
      : 'Tu as une base orale correcte, la prochaine lecon doit surtout enrichir le reemploi.';
    courseFocusArea = speakingFocusArea === 'pronunciation'
      ? 'Structures orales courtes'
      : speakingFocusArea === 'fluency'
        ? 'Fluidite et enchainement'
        : 'Precision des structures';
  } else if (params.focusSkill === 'reading') {
    courseReason = 'Une lecon de structure t aidera a mieux exploiter les contenus lus en contexte.';
    courseFocusArea = 'Structure lue en contexte';
  } else if (params.focusSkill === 'listening') {
    courseReason = 'Le vocabulaire naturel et les patrons frequents t aideront a mieux suivre l audio.';
    courseFocusArea = 'Patrons frequents a l oreille';
  }

  let coachHint = 'Vise une prise courte, nette et sans stress.';
  if (speakingFocusArea === 'pronunciation') {
    coachHint = 'Reste sur des repetitions courtes et propres. Le but est de remettre en place les sons, le rythme et la confiance.';
  } else if (speakingFocusArea === 'fluency') {
    coachHint = 'Fais une reponse simple mais continue, sans chercher a faire trop complexe. Priorite au flux et a la fluidite.';
  } else if (speakingFocusArea === 'accuracy') {
    coachHint = 'Garde des phrases courtes mais tres propres. Mieux vaut peu de mots bien poses qu une longue phrase fragile.';
  } else if (preferredExerciseType === 'repeat') {
    coachHint = 'Commence par repeter une structure propre pour remettre prononciation et rythme en place.';
  } else if (params.newCount > 0) {
    coachHint = 'Essaie une reponse libre pour reutiliser des mots appris recemment dans une phrase complete.';
  } else if (params.focusSkill === 'speaking') {
    coachHint = 'Passe en reponse libre pour transformer ton stock passif en anglais vraiment actif.';
  }

  if (topWeakness?.source === 'reading' && params.courseWeakness?.label) {
    coachHint += ` Si possible, reutilise ${params.courseWeakness.label.toLowerCase()} dans ta prochaine prise.`;
  }

  const speakingPrompt = buildSpeakingPromptPlan({
    focusArea: speakingFocusArea,
    focusSkill: params.focusSkill,
    level: params.level,
    preferredExerciseType,
    topWeakness,
  });

  return {
    course: {
      focusArea: courseFocusArea,
      reason: courseReason,
      recommendedLessonId: lessonId,
      weaknessLabel: params.courseWeakness?.label ?? null,
      weaknessSource: params.courseWeakness?.source ?? null,
    },
    speaking: {
      coachHint,
      focusArea: speakingFocusArea,
      preferredExerciseType,
      prompt: speakingPrompt.prompt,
      promptLabel: speakingPrompt.promptLabel,
    },
  };
}

export async function handleTrackLearningEvent(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<LearningEventBody>().catch(() => null);
  if (!body?.profileId || !body?.module || !body?.eventType || !body?.skill) {
    return err('profileId, module, eventType et skill requis');
  }

  const occurredAt = body.occurredAt ?? isoNow();
  const payload = JSON.stringify(body.payload ?? {});

  await env.DB.prepare(`
    INSERT INTO learning_events (
      id, profile_id, module, event_type, skill, content_id, score, duration_sec, payload, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    makeEventId(body.profileId),
    body.profileId,
    body.module,
    body.eventType,
    body.skill,
    body.contentId ?? null,
    body.score ?? null,
    body.durationSec ?? null,
    payload,
    occurredAt,
  ).run();

  return json({ ok: true });
}

export async function handleGetDailyMission(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const today = new Date().toISOString().slice(0, 10);

  const [
    profileRow,
    dueRow,
    learnedRow,
    totalRow,
    historyResult,
    recentEventsResult,
    recentDetailedEventsResult,
    lastEventRow,
  ] = await Promise.all([
    env.DB.prepare('SELECT level, daily_goal FROM profiles WHERE id = ?').bind(profileId).first<{ level: string; daily_goal: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM word_progress
       WHERE profile_id = ? AND repetitions > 0 AND prochaine_revision <= datetime('now')`,
    ).bind(profileId).first<CountRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count
       FROM word_progress
       WHERE profile_id = ? AND repetitions > 0`,
    ).bind(profileId).first<CountRow>(),
    env.DB.prepare('SELECT COUNT(*) as count FROM words').first<CountRow>(),
    env.DB.prepare(
      'SELECT day, count FROM review_history_daily WHERE profile_id = ? ORDER BY day DESC LIMIT 14',
    ).bind(profileId).all<DailyCountRow>(),
    env.DB.prepare(
      `SELECT module, COUNT(*) as event_count, AVG(score) as avg_score
       FROM learning_events
       WHERE profile_id = ? AND occurred_at >= datetime('now', '-7 days')
       GROUP BY module`,
    ).bind(profileId).all<GroupedEventRow>(),
    env.DB.prepare(
      `SELECT module, event_type, score, payload, occurred_at
       FROM learning_events
       WHERE profile_id = ?
       ORDER BY occurred_at DESC
       LIMIT 30`,
    ).bind(profileId).all<LearningEventRow>(),
    env.DB.prepare(
      'SELECT occurred_at FROM learning_events WHERE profile_id = ? ORDER BY occurred_at DESC LIMIT 1',
    ).bind(profileId).first<{ occurred_at: string }>(),
  ]);

  const dailyGoal = profileRow?.daily_goal ?? 20;
  const dueCount = dueRow?.count ?? 0;
  const learnedCount = learnedRow?.count ?? 0;
  const totalCount = totalRow?.count ?? 0;
  const newCount = Math.max(0, totalCount - learnedCount);
  const reviewedToday = lastDailyCount(historyResult.results, today);

  const speakSessions7d = safeEventCount(recentEventsResult.results, 'speak');
  const speakAvgScore7d = safeAverage(recentEventsResult.results, 'speak');
  const readSessions7d = safeEventCount(recentEventsResult.results, 'read');
  const readAvgScore7d = safeAverage(recentEventsResult.results, 'read');
  const listenSessions7d = safeEventCount(recentEventsResult.results, 'listen');
  const listenAvgScore7d = safeAverage(recentEventsResult.results, 'listen');
  const reviewEvents7d = safeEventCount(recentEventsResult.results, 'review') + safeEventCount(recentEventsResult.results, 'lingvist');
  const reviewAvgScore7d = safeAverage(recentEventsResult.results, 'review');
  const weeklyActiveDays = historyResult.results
    .slice(0, 7)
    .filter((row) => row.count > 0)
    .length;
  const remainingReviews = Math.max(0, Math.min(dailyGoal, Math.max(dueCount, reviewedToday)) - reviewedToday);
  const weaknesses = deriveWeaknesses({
    dueCount,
    recentEvents: recentDetailedEventsResult.results,
    reviewAvgScore7d,
    speakAvgScore7d,
  });
  const topWeakness = weaknesses[0] ?? null;
  const courseWeakness = weaknesses.find((item) => item.lessonId) ?? null;

  let focusSkill: LearningSkill = 'vocabulary';
  let summary = 'Garde une boucle simple : consolider, ajouter un peu de nouveau, puis reemployer a l oral.';
  let primaryAction = {
    badge: dueCount > 0 ? `${dueCount} a revoir` : 'Session libre',
    id: 'review_due',
    minutes: 8,
    route: MODULE_ROUTE_MAP.review,
    subtitle: dueCount > 0
      ? `${remainingReviews || Math.min(dueCount, 12)} cartes suffisent pour remettre la memoire en mouvement.`
      : 'Une courte session de maintien suffit pour garder la memoire active.',
    title: 'Reviser maintenant',
  };

  if (dueCount >= Math.max(8, Math.floor(dailyGoal * 0.6))) {
    focusSkill = 'vocabulary';
    summary = `Le vrai levier du jour, c est la consolidation. ${dueCount} cartes en attente risquent de ralentir la retention si tu les repousses.`;
  } else if (speakSessions7d === 0 || (speakAvgScore7d ?? 1) < 0.62) {
    focusSkill = 'speaking';
    summary = speakSessions7d === 0
      ? 'Tu nourris deja le stock de mots. Il manque surtout une reactivation orale pour transformer ce capital en aisance.'
      : "Tu parles deja un peu, mais les derniers scores montrent qu'il faut securiser l'oral avant d'allonger les reponses.";
    primaryAction = {
      badge: `Niveau ${profileRow?.level ?? 'B1'}`,
      id: 'speak_session',
      minutes: 6,
      route: MODULE_ROUTE_MAP.speak,
      subtitle: 'Une reponse orale ou une repetition guidee suffit pour remettre la bouche en route.',
      title: 'Faire une prise orale',
    };
  } else if (newCount > 0 && reviewedToday < dailyGoal) {
    focusSkill = 'vocabulary';
    summary = `Ton flux SRS peut encore accueillir du nouveau. ${newCount} mots sont disponibles pour continuer a monter en volume utile.`;
    primaryAction = {
      badge: `${newCount} nouveaux`,
      id: 'learn_words',
      minutes: 7,
      route: MODULE_ROUTE_MAP.learn,
      subtitle: 'Ajoute une petite serie propre pour nourrir les prochaines revisions.',
      title: 'Apprendre une serie courte',
    };
  } else if (readSessions7d === 0) {
    focusSkill = 'reading';
    summary = 'Ton systeme tourne, mais il manque une exposition en contexte. Une lecture guidee apportera du vocabulaire vivant.';
    primaryAction = {
      badge: `Niveau ${profileRow?.level ?? 'B1'}`,
      id: 'read_article',
      minutes: 8,
      route: MODULE_ROUTE_MAP.read,
      subtitle: 'Lis un article adapte a ton niveau puis traite la question de comprehension.',
      title: 'Faire une lecture utile',
    };
  } else if (listenSessions7d === 0) {
    focusSkill = 'listening';
    summary = 'Un peu d input audio manque encore cette semaine. Un podcast court aidera a stabiliser le rythme et la comprehension.';
    primaryAction = {
      badge: 'Audio du jour',
      id: 'listen_podcast',
      minutes: 9,
      route: MODULE_ROUTE_MAP.listen,
      subtitle: 'Ecoute, revele le transcript au besoin, puis valide le quiz final.',
      title: 'Faire une session ecoute',
    };
  }

  if (topWeakness?.source === 'lingvist' && dueCount > 0) {
    focusSkill = 'vocabulary';
    summary = `Le signal le plus exploitable vient de Lingvist : ${topWeakness.label.toLowerCase()}. La prochaine session doit consolider ce point precis.`;
    primaryAction = {
      badge: topWeakness.label,
      id: 'lingvist_targeted',
      minutes: 8,
      route: MODULE_ROUTE_MAP.lingvist,
      subtitle: topWeakness.recommendation,
      title: 'Faire une session Lingvist ciblee',
    };
  }

  const supportingActions = [
    {
      badge: `${newCount} nouveaux`,
      id: 'support_learn',
      minutes: 6,
      route: MODULE_ROUTE_MAP.learn,
      subtitle: 'Nourrir le stock si tu as encore de l energie.',
      title: 'Apprendre',
    },
    {
      badge: `Oral ${speakSessions7d}/7j`,
      id: 'support_speak',
      minutes: 5,
      route: MODULE_ROUTE_MAP.speak,
      subtitle: 'Transformer les connaissances passives en parole.',
      title: 'Parler',
    },
    {
      badge: `${reviewEvents7d} actions / 7j`,
      id: 'support_review',
      minutes: 6,
      route: MODULE_ROUTE_MAP.review,
      subtitle: 'Revenir sur les cartes encore instables.',
      title: 'Reviser',
    },
  ].filter((item) => item.route !== primaryAction.route).slice(0, 2);

  const guidance = buildGuidance({
    courseWeakness,
    dueCount,
    focusSkill,
    level: profileRow?.level,
    newCount,
    speakAvgScore7d,
    speakSessions7d,
    weaknesses,
  });
  if (primaryAction.id === 'speak_session') {
    primaryAction = {
      ...primaryAction,
      route: buildSpeakingRoute(guidance.speaking.preferredExerciseType, guidance.speaking.prompt),
    };
  }
  const resolvedSupportingActions = supportingActions.map((action) =>
    action.id === 'support_speak'
      ? {
        ...action,
        route: buildSpeakingRoute(guidance.speaking.preferredExerciseType, guidance.speaking.prompt),
      }
      : action,
  );
  const bridge = deriveBridge({
    preferredExerciseType: guidance.speaking.preferredExerciseType,
    recentEvents: recentDetailedEventsResult.results,
  });
  const weeklyPath = buildWeeklyPath({
    bridge,
    dueCount,
    focusSkill,
    listenSessions7d,
    primaryAction,
    readSessions7d,
    reviewEvents7d,
    reviewedToday,
    speakAvgScore7d,
    speakSessions7d,
    supportingActions: resolvedSupportingActions,
    weeklyActiveDays,
    weaknesses,
  });
  const recoveryPlan = buildRecoveryPlan({
    activeDays7d: weeklyActiveDays,
    bridge,
    dueCount,
    focusSkill,
    primaryAction,
    supportingActions: resolvedSupportingActions,
    weeklyPath,
  });
  const pedagogicalProfile = buildPedagogicalProfile({
    bridge,
    dueCount,
    focusSkill,
    listenSessions7d,
    readSessions7d,
    reviewEvents7d,
    reviewedToday,
    speakAvgScore7d,
    speakSessions7d,
    weaknesses,
    weeklyActiveDays,
  });
  const roadmap7d = buildWeeklyRoadmap({
    bridge,
    completionEvents: recentDetailedEventsResult.results,
    focusSkill,
    primaryAction,
    supportingActions: resolvedSupportingActions,
    weeklyPath,
  });

  return json({
    bridge,
    energy:
      dueCount >= dailyGoal ? 'push' : reviewedToday >= Math.max(1, Math.floor(dailyGoal / 2)) ? 'light' : 'steady',
    focusSkill,
    missionDate: today,
    pedagogicalProfile,
    primaryAction,
    profileId,
    signals: {
      activeDays7d: weeklyActiveDays,
      dailyGoal,
      dueCount,
      lastActiveAt: lastEventRow?.occurred_at ?? null,
      learnedCount,
      listenAvgScore7d,
      listenSessions7d,
      newCount,
      readAvgScore7d,
      readSessions7d,
      reviewedToday,
      reviewAvgScore7d,
      reviewEvents7d,
      speakAvgScore7d,
      speakSessions7d,
    },
    guidance,
    recoveryPlan,
    roadmap7d,
    weeklyPath,
    weaknesses,
    subtitle:
      reviewedToday >= dailyGoal
        ? 'Objectif quotidien atteint. Tu peux maintenant viser le bon complement.'
        : `${Math.max(0, dailyGoal - reviewedToday)} actions pour tenir ton cap du jour.`,
    summary,
    supportingActions: resolvedSupportingActions,
    title:
      focusSkill === 'speaking'
        ? 'Remettre l anglais en bouche'
        : focusSkill === 'reading'
          ? 'Remettre du contexte'
          : focusSkill === 'listening'
            ? 'Recalibrer l oreille'
            : 'Consolider le socle actif',
  });
}

export async function handleGetLearningInsights(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';

  const [recentDetailedEventsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT module, event_type, score, payload, occurred_at
       FROM learning_events
       WHERE profile_id = ?
       ORDER BY occurred_at DESC
       LIMIT 40`,
    ).bind(profileId).all<LearningEventRow>(),
  ]);

  const recentRecycling = buildRecentRecyclingItems(recentDetailedEventsResult.results);
  const recentExpressions = buildRecentRecycledExpressions(recentDetailedEventsResult.results);
  const totalPromoted7d = recentRecycling.reduce((sum, item) => sum + item.promotedCount, 0);
  const byModule = {
    listen: recentRecycling.filter((item) => item.module === 'listen').reduce((sum, item) => sum + item.promotedCount, 0),
    read: recentRecycling.filter((item) => item.module === 'read').reduce((sum, item) => sum + item.promotedCount, 0),
    speak: recentRecycling.filter((item) => item.module === 'speak').reduce((sum, item) => sum + item.promotedCount, 0),
  };

  return json({
    profileId,
    recycling: {
      byModule,
      expressions: recentExpressions,
      items: recentRecycling,
      totalPromoted7d,
    },
  });
}

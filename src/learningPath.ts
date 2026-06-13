export type LearningPathFocusSkill = 'vocabulary' | 'speaking' | 'reading' | 'listening' | 'grammar';
export type LearningPathSpeakingFocusArea = 'pronunciation' | 'fluency' | 'accuracy' | 'activation';

export interface LearningWeaknessSnapshot {
  id: string;
  label: string;
}

export const GRAMMAR_TO_LESSON: { lessonId: string; pattern: RegExp; label: string }[] = [
  { lessonId: 'L01', pattern: /simple past|past simple|preterit/i, label: 'Simple Past' },
  { lessonId: 'L02', pattern: /\barticles?\b|a\/an|definite article|indefinite article/i, label: 'Articles' },
  { lessonId: 'L03', pattern: /present perfect|have\s+\+\s+past|for\/since|\bsince\b|\balready\b|\byet\b|\bjust\b/i, label: 'Present Perfect' },
  { lessonId: 'L04', pattern: /\bwill\b.*going to|future simple|future tense|modal|should|must|might|could|would|be able to/i, label: 'Will vs Going to' },
  { lessonId: 'L05', pattern: /first conditional|zero conditional|if.*will|preposition/i, label: 'First Conditional' },
  { lessonId: 'L06', pattern: /phrasal verb/i, label: 'Phrasal Verbs' },
  { lessonId: 'L07', pattern: /passive voice|passive form|be \+ past participle|comparative|superlative/i, label: 'Passive Voice' },
  { lessonId: 'L08', pattern: /reported speech|indirect speech|question tag|linking word|connector|however|although|despite|word order/i, label: 'Reported Speech' },
  { lessonId: 'L09', pattern: /second conditional|third conditional|unreal|would have/i, label: 'Conditionals 2 & 3' },
  { lessonId: 'L10', pattern: /business english|collocation|professional english/i, label: 'Business Collocations' },
];

export const SIGNAL_META: Record<string, { label: string; lessonId: string | null; recommendation: string }> = {
  agreement: {
    label: 'Accords de base',
    lessonId: 'L02',
    recommendation: 'Revois des structures tres simples pour fiabiliser les accords et les automatismes.',
  },
  articles: {
    label: 'Articles',
    lessonId: 'L02',
    recommendation: 'Travaille a/an/the dans des phrases courtes avant de complexifier tes reponses.',
  },
  collocations: {
    label: 'Collocations',
    lessonId: 'L10',
    recommendation: 'Renforce les combinaisons naturelles de mots pour sonner plus juste.',
  },
  plurality: {
    label: 'Singulier / pluriel',
    lessonId: 'L02',
    recommendation: 'Stabilise les formes singulier-pluriel et les noms comptables / non comptables.',
  },
  prepositions: {
    label: 'Prepositions',
    lessonId: 'L05',
    recommendation: 'Reprends les prepositions frequentes dans des structures tres courantes.',
  },
  spelling: {
    label: 'Orthographe',
    lessonId: null,
    recommendation: 'Ralentis legerement et consolide les formes ecrites avant de chercher plus de vitesse.',
  },
  tense: {
    label: 'Temps verbaux',
    lessonId: 'L03',
    recommendation: 'Une lecon de temps verbaux t aidera a produire plus proprement et plus naturellement.',
  },
  word_order: {
    label: 'Ordre des mots',
    lessonId: 'L08',
    recommendation: 'Revois des patrons de phrases simples pour mieux placer chaque element.',
  },
};

export const SIGNAL_RULES: { id: string; pattern: RegExp }[] = [
  { id: 'articles', pattern: /\barticle\b|a\/an|the\b|determiner|missing article|wrong article/i },
  { id: 'prepositions', pattern: /\bpreposition\b|for\/since|in\/on\/at|to\/for|depend on|arrive in|arrive at/i },
  { id: 'tense', pattern: /present perfect|simple past|past simple|future|conditional|tense|conjug|verb tense/i },
  { id: 'word_order', pattern: /word order|syntax|sentence order|wrong order|position in the sentence/i },
  { id: 'plurality', pattern: /plural|singular|countable|uncountable|plural form/i },
  { id: 'collocations', pattern: /collocation|phrasal verb|natural phrase|idiom|more natural/i },
  { id: 'spelling', pattern: /spelling|orthograph|typo|misspell/i },
  { id: 'agreement', pattern: /agreement|subject verb|verb agreement/i },
];

export function normalizeLearningLevel(level: string | null | undefined): 'A2' | 'B1' | 'B2' | 'C1' {
  if (level === 'A2' || level === 'B1' || level === 'B2' || level === 'C1') return level;
  return 'B1';
}

export function matchGrammarPattern(pattern: string): { lessonId: string; label: string } | null {
  for (const item of GRAMMAR_TO_LESSON) {
    if (item.pattern.test(pattern)) {
      return { lessonId: item.lessonId, label: item.label };
    }
  }
  return null;
}

export function pickCourseLessonId(params: {
  focusSkill: LearningPathFocusSkill;
  grammarLessonId?: string | null;
  level: string | null | undefined;
  speakAvgScore7d: number | null;
}): string | null {
  if (params.grammarLessonId) return params.grammarLessonId;
  const level = normalizeLearningLevel(params.level);

  if (params.focusSkill === 'vocabulary') {
    return level === 'B2' || level === 'C1' ? 'L10' : 'L06';
  }

  if (params.focusSkill === 'speaking') {
    if ((params.speakAvgScore7d ?? 0) < 0.58) {
      return level === 'B2' || level === 'C1' ? 'L08' : 'L02';
    }
    return level === 'B2' || level === 'C1' ? 'L09' : 'L04';
  }

  if (params.focusSkill === 'reading') {
    return level === 'B2' || level === 'C1' ? 'L07' : 'L03';
  }

  if (params.focusSkill === 'listening') {
    return level === 'B2' || level === 'C1' ? 'L10' : 'L06';
  }

  return level === 'B2' || level === 'C1' ? 'L07' : 'L03';
}

export function buildSpeakingPromptPlan(params: {
  focusArea: LearningPathSpeakingFocusArea;
  focusSkill: LearningPathFocusSkill;
  level: string | null | undefined;
  preferredExerciseType: 'repeat' | 'respond';
  topWeakness: LearningWeaknessSnapshot | null;
}): { prompt: string; promptLabel: string | null } {
  const level = normalizeLearningLevel(params.level);
  const weaknessLabel = params.topWeakness?.label ?? null;

  if (params.preferredExerciseType === 'repeat') {
    if (params.topWeakness?.id.includes('articles')) {
      return { prompt: 'I booked a meeting with a client and sent the agenda in the morning.', promptLabel: weaknessLabel };
    }
    if (params.topWeakness?.id.includes('prepositions')) {
      return { prompt: 'I have worked on this project since Monday, and I am still focused on it.', promptLabel: weaknessLabel };
    }
    if (params.topWeakness?.id.includes('tense')) {
      return { prompt: 'I have changed my routine recently because I wanted to be more consistent.', promptLabel: weaknessLabel };
    }
    if (params.topWeakness?.id.includes('word_order')) {
      return { prompt: 'I only realized after the meeting that the client had changed the deadline.', promptLabel: weaknessLabel };
    }
    if (params.topWeakness?.id.includes('collocations')) {
      return { prompt: 'The team reached a final decision and took immediate action after the review.', promptLabel: weaknessLabel };
    }
    if (params.focusArea === 'pronunciation') {
      return {
        prompt: level === 'A2'
          ? 'I would like to speak more clearly and more confidently every day.'
          : 'We should slow down slightly so that every word stays clear and controlled.',
        promptLabel: weaknessLabel,
      };
    }
    return {
      prompt: level === 'A2'
        ? 'I can describe my day clearly and keep my sentences simple.'
        : 'I can give a short, clear answer without rushing and without losing structure.',
      promptLabel: weaknessLabel,
    };
  }

  if (params.topWeakness?.id.includes('articles')) {
    return { prompt: 'Describe a product or a service you use every day. Try to use a, an, and the clearly.', promptLabel: weaknessLabel };
  }
  if (params.topWeakness?.id.includes('prepositions')) {
    return { prompt: 'Explain how you organize your week. Try to use in, on, at, for, and since naturally.', promptLabel: weaknessLabel };
  }
  if (params.topWeakness?.id.includes('tense')) {
    return { prompt: 'Talk about something you have changed recently and explain why it matters now.', promptLabel: weaknessLabel };
  }
  if (params.topWeakness?.id.includes('word_order')) {
    return { prompt: 'Describe a recent meeting in 2 or 3 short sentences with very clear sentence structure.', promptLabel: weaknessLabel };
  }
  if (params.topWeakness?.id.includes('collocations')) {
    return { prompt: 'Describe a work situation using natural verb-noun combinations like make a decision or take action.', promptLabel: weaknessLabel };
  }
  if (params.focusArea === 'fluency') {
    return { prompt: 'Tell me about your day in 3 connected sentences without stopping too often.', promptLabel: weaknessLabel };
  }
  if (params.focusArea === 'accuracy') {
    return { prompt: 'Describe a recent task using short but very correct sentences.', promptLabel: weaknessLabel };
  }
  if (params.focusSkill === 'reading' || params.focusSkill === 'listening') {
    return { prompt: 'Summarize one useful idea you learned this week in 2 or 3 sentences.', promptLabel: weaknessLabel };
  }

  return {
    prompt: 'Answer in 2 or 3 clear sentences and try to sound calm, precise, and natural.',
    promptLabel: weaknessLabel,
  };
}

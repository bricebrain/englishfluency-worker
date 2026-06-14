/** Secret issu du Cloudflare Secrets Store — accès async via .get() */
interface SecretsStoreSecret {
  get(): Promise<string>;
}

export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  // Service Binding vers le Worker TechPulse (même compte Cloudflare, zéro latence HTTP)
  TECHPULSE: Fetcher;
  // Per-worker secret classique
  API_SECRET?: string;
  RUNPOD_API_KEY?: string;
  RUNPOD_AI_ENDPOINT_ID?: string;
  // Secret classique (wrangler secret put) — lu directement comme string
  DEEPGRAM_API_KEY?: string;
  // YouTube API keys (wrangler secret put)
  YT_READ_KEY_1?: string;
  YT_READ_KEY_2?: string;
  YT_READ_KEY_3?: string;
  YT_SEARCH_KEY_1?: string;
  YT_SEARCH_KEY_2?: string;
  YT_SEARCH_KEY_3?: string;
  // Cloudflare Secrets Store (un seul store, tous les workers y accèdent)
  OPENAI_API_KEY: SecretsStoreSecret;
  OPENROUTER_API_KEY: SecretsStoreSecret;
  GEMINI_API_KEY: SecretsStoreSecret;
  GROQ_API_KEY_1: SecretsStoreSecret;
  GROQ_API_KEY_2: SecretsStoreSecret;
  DEEPSEEK_API_KEY: SecretsStoreSecret;
  XAI_API_KEY: SecretsStoreSecret;
}

export interface WordRow {
  id: string;
  mot: string;
  type: string;
  niveau: string;
  traduction: string | null;
  ipa_uk: string | null;
  ipa_us: string | null;
  audio_uk: string;
  audio_us: string;
  registre: string;
  faux_ami: number;          // 0 | 1 (SQLite boolean)
  faux_ami_note: string | null;
  frequence: number;
  examples: string;          // JSON TEXT → [{en, fr}]
  synonymes: string;         // JSON TEXT → string[]
  collocations: string;      // JSON TEXT → string[]
  famille_de_mots: string;   // JSON TEXT → {noun,verb,adj,adv}
  tags: string;              // JSON TEXT → string[]
  created_at: string;
  updated_at: string;
}

export interface Word {
  id: string;
  mot: string;
  type: string;
  niveau: string;
  traduction: string | null;
  ipa_uk: string | null;
  ipa_us: string | null;
  audio_uk: string;
  audio_us: string;
  registre: string;
  faux_ami: boolean;
  faux_ami_note: string | null;
  frequence: number;
  examples: Array<{ en: string; fr: string }>;
  synonymes: string[];
  collocations: string[];
  famille_de_mots: { noun: string | null; verb: string | null; adj: string | null; adv: string | null };
  tags: string[];
}

export function rowToWord(row: WordRow): Word {
  return {
    id:             row.id,
    mot:            row.mot,
    type:           row.type,
    niveau:         row.niveau,
    traduction:     row.traduction,
    ipa_uk:         row.ipa_uk,
    ipa_us:         row.ipa_us,
    audio_uk:       row.audio_uk,
    audio_us:       row.audio_us,
    registre:       row.registre,
    faux_ami:       row.faux_ami === 1,
    faux_ami_note:  row.faux_ami_note,
    frequence:      row.frequence,
    examples:       safeJson(row.examples, []),
    synonymes:      safeJson(row.synonymes, []),
    collocations:   safeJson(row.collocations, []),
    famille_de_mots: safeJson(row.famille_de_mots, { noun: null, verb: null, adj: null, adv: null }),
    tags:           safeJson(row.tags, []),
  };
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

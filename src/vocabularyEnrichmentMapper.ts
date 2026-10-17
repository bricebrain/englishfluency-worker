/**
 * Jointure des enrichissements publiés (atelier Vocabulaire) aux mots renvoyés
 * par les routes d'apprentissage. Un seul LEFT JOIN par requête (pas de N+1),
 * et seuls les champs utiles à l'apprentissage sont exposés : les champs
 * d'audit (originalWord, reviewNote, source_snapshot, batchId…) restent ici.
 */

export const ENRICHMENT_JOIN_SQL = 'LEFT JOIN vocabulary_enrichments ve ON ve.word_id = w.id';

export const ENRICHMENT_SELECT_SQL =
  've.data AS enrichment_data, ve.version AS enrichment_version, ve.published_at AS enrichment_published_at';

export interface EnrichmentColumns {
  enrichment_data?: string | null;
  enrichment_version?: number | null;
  enrichment_published_at?: string | null;
}

export interface VocabularySenseDto {
  senseKey: string;
  partOfSpeech: string;
  translation: string;
  exampleEn: string;
  exampleFr: string;
}

export interface VocabularyCollocationDto {
  en: string;
  fr: string;
  kind: string;
  senseKey: string;
}

export interface VocabularyEnrichmentDto {
  schemaVersion: 1;
  version: number;
  publishedAt: string;
  lemma: string;
  displayForm: string;
  partOfSpeech: string;
  primaryTranslation: string;
  translationStatus: string;
  senses: VocabularySenseDto[];
  collocations: VocabularyCollocationDto[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Enrichissement public, ou `null` si absent ou illisible (le mot garde alors ses champs historiques). */
export function toVocabularyEnrichmentDto(columns: EnrichmentColumns): VocabularyEnrichmentDto | null {
  if (!columns.enrichment_data) return null;
  let data: Record<string, unknown> | null;
  try {
    data = record(JSON.parse(columns.enrichment_data));
  } catch {
    return null;
  }
  if (!data || !text(data.lemma)) return null;

  const senses = (Array.isArray(data.senses) ? data.senses : [])
    .map(record)
    .filter((sense): sense is Record<string, unknown> => Boolean(sense && text(sense.translation)))
    .map((sense) => ({
      senseKey: text(sense.senseKey),
      partOfSpeech: text(sense.partOfSpeech) || 'other',
      translation: text(sense.translation),
      exampleEn: text(sense.exampleEn),
      exampleFr: text(sense.exampleFr),
    }));

  const collocations = (Array.isArray(data.collocations) ? data.collocations : [])
    .map(record)
    .filter((item): item is Record<string, unknown> => Boolean(item && text(item.en)))
    .map((item) => ({
      en: text(item.en),
      fr: text(item.fr),
      kind: text(item.kind) || 'collocation',
      senseKey: text(item.senseKey),
    }));

  return {
    schemaVersion: 1,
    version: Number(columns.enrichment_version ?? 1),
    publishedAt: text(columns.enrichment_published_at),
    lemma: text(data.lemma).replace(/^to\s+/i, ''),
    displayForm: text(data.displayForm) || text(data.lemma),
    partOfSpeech: text(data.partOfSpeech) || 'other',
    primaryTranslation: text(data.primaryTranslation),
    translationStatus: text(data.translationStatus),
    senses,
    collocations,
  };
}

/** Retire les colonnes techniques de la jointure et ajoute `enrichment`. */
export function withEnrichment<T extends EnrichmentColumns>(
  row: T,
): Omit<T, keyof EnrichmentColumns> & { enrichment: VocabularyEnrichmentDto | null } {
  const { enrichment_data, enrichment_version, enrichment_published_at, ...rest } = row;
  return {
    ...rest,
    enrichment: toVocabularyEnrichmentDto({ enrichment_data, enrichment_version, enrichment_published_at }),
  };
}

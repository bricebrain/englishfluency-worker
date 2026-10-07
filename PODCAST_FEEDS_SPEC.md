# Podcast Feeds → Reading Lessons — Contrat API

Transformer des transcripts de podcasts anglais authentiques (news + conversations)
en contenu à lire avec cours sur la structure et les signaux linguistiques.

## Vision

"Lire" s'enrichit d'une nouvelle source : des transcripts Deepgram de podcasts
authentiques. Contrairement aux articles aseptisés, un transcript est de l'anglais
*réel* — hésitations, fillers, "gonna", tours de parole. C'est l'or pédagogique
que personne n'exploite.

On commence par les **conversations** (BBC 6 Minute English, Leonardo English),
qui bénéficient de la diarisation Deepgram et du shadowing audio.

## Sources initiales

### Conversations (priorité 1)
- `https://podcasts.files.bbci.co.uk/p02pc9zn.rss` — BBC 6 Minute English (pédagogique, B1-B2)
- `https://feeds.transistor.fm/leonardo-english-english-language-learning-for-curious-minds` — Leonardo English (pédagogique, B2-C1)

### News / récits (priorité 2 — plus tard)
- `https://feeds.megaphone.fm/SBP7078874085`
- `https://rss.acast.com/storiesofourtimes`
- `https://feeds.libsyn.com/529197/rss`
- `https://rss.buzzsprout.com/2187419.rss`

## Réutilisation de l'existant

- **Deepgram Nova-3** : `transcribeWithDeepgram()` dans `assimilDeepgram.ts` — transcription + diarisation native + timestamps + ponctuation en un appel. Réutilisé tel quel.
- **R2 binding `AUDIO`** : stockage audio mirroré pour shadowing par timestamps.
- **D1 binding `DB`** : persistance.
- **Mémoire pédagogique** : `trackLearningEvent` déjà en place — signaux émis depuis les lessons.
- **SRS** : `promoteArticleWordsToSrs` (`/articles/promote-words`) déjà câblé pour le vocabulaire → on réutilisera le même endpoint ou un équivalent.

---

## Schéma D1 (migration 0010)

### `podcast_feeds` — flux RSS configurés

| Colonne              | Type    | Notes                                              |
|----------------------|---------|----------------------------------------------------|
| `id`                 | TEXT PK | slug stable (ex: `bbc-6min`, `leonardo-english`)   |
| `title`              | TEXT    |                                                    |
| `rss_url`            | TEXT    | unique                                             |
| `kind`               | TEXT    | `'conversation'` \| `'news'` \| `'tech'`           |
| `language`           | TEXT    | default `'en'`                                     |
| `cefr_level_hint`    | TEXT    | nullable — pour feeds pédagogiques (ex: `'B1-B2'`) |
| `enabled`            | INTEGER | 0 \| 1                                             |
| `image_url`          | TEXT    | nullable                                           |
| `last_fetched_at`    | TEXT    | nullable                                           |
| `created_at`         | TEXT    | `datetime('now')`                                  |
| `updated_at`         | TEXT    | `datetime('now')`                                  |

### `podcast_episodes` — épisodes scannés + transcrits

| Colonne                  | Type    | Notes                                                                  |
|--------------------------|---------|------------------------------------------------------------------------|
| `id`                     | TEXT PK | hash stable du guid/enclosure                                          |
| `feed_id`                | TEXT    | FK → `podcast_feeds.id`                                                |
| `title`                  | TEXT    |                                                                        |
| `description`            | TEXT    | résumé du feed                                                         |
| `audio_url`              | TEXT    | URL source (enclosure RSS)                                             |
| `duration_sec`           | INTEGER | depuis le feed si dispo                                                |
| `published_at`           | TEXT    | ISO                                                                    |
| `image_url`              | TEXT    | nullable                                                               |
| `transcription_status`   | TEXT    | `'pending'` \| `'transcribing'` \| `'ready'` \| `'failed'`             |
| `transcription_provider` | TEXT    | nullable — `'deepgram'` \| `'gemini'` \| `'openai'`                    |
| `transcript_text`        | TEXT    | nullable — texte brut concaténé                                        |
| `dialogue_json`          | TEXT    | nullable — `[{speaker, text, start, end}]` (Deepgram utterances)       |
| `lesson_status`          | TEXT    | `'pending'` \| `'generating'` \| `'ready'` \| `'failed'`               |
| `lesson_json`            | TEXT    | nullable — `ReadingLessonPack` (voir Types)                            |
| `audio_key`              | TEXT    | nullable — key R2 si audio mirroré (`podcasts/episodes/<id>.mp3`)      |
| `created_at`             | TEXT    |                                                                        |
| `updated_at`             | TEXT    |                                                                        |

**Index :**
- `idx_podcast_episodes_feed_date` ON `(feed_id, published_at DESC)`
- `idx_podcast_episodes_transcription` ON `(transcription_status)` (partial WHERE != 'ready')
- `idx_podcast_episodes_lesson` ON `(lesson_status)` (partial WHERE != 'ready')

---

## Endpoints

Toutes les routes sont préfixées `/podcast-feeds`. Auth : `Bearer <API_SECRET>` (via `isAuthorized`).

### Admin — gestion des feeds

#### `GET /podcast-feeds`
Liste tous les feeds + compteurs d'épisodes.

**Réponse 200 :**
```json
{
  "feeds": [
    {
      "id": "bbc-6min",
      "title": "6 Minute English",
      "rssUrl": "https://podcasts.files.bbci.co.uk/p02pc9zn.rss",
      "kind": "conversation",
      "cefrLevelHint": "B1-B2",
      "enabled": true,
      "imageUrl": null,
      "lastFetchedAt": "2026-06-19T08:00:00Z",
      "episodeCount": 42,
      "readyCount": 18
    }
  ]
}
```

#### `POST /podcast-feeds`
Ajoute un feed. Le worker scanne le RSS immédiatement (synchrone, ~30 épisodes max).

**Body :**
```json
{ "id": "leonardo-english", "title": "Leonardo English", "rssUrl": "https://...", "kind": "conversation", "cefrLevelHint": "B2-C1" }
```
**Réponse 201 :** `{ ok: true, feed, scannedEpisodes: 27 }`

#### `PATCH /podcast-feeds/:feedId`
Toggle enable/disable ou update metadata.
**Body :** `{ "enabled": false }` (ou `cefrLevelHint`, `kind`)
**Réponse 200 :** `{ ok: true }`

#### `DELETE /podcast-feeds/:feedId`
Supprime le feed + ses épisodes (et optionnellement l'audio R2).
**Réponse 200 :** `{ ok: true, deletedEpisodes: 42 }`

#### `POST /podcast-feeds/refresh`
Re-scanne tous les feeds activés. Idempotent (skip les épisodes déjà connus via `id`).
**Réponse 200 :** `{ ok: true, newEpisodes: 7 }`

---

### Épisodes

#### `GET /podcast-feeds/:feedId/episodes`
Liste les épisodes d'un feed, triés par `published_at DESC`.

**Query :** `?limit=30&offset=0&status=ready` (`status` filtre sur `transcription_status` ou `lesson_status`)
**Réponse 200 :**
```json
{
  "episodes": [
    {
      "id": "ep_abc123",
      "feedId": "bbc-6min",
      "title": "Why do we laugh?",
      "description": "Neil and Sam discuss...",
      "durationSec": 360,
      "publishedAt": "2026-06-15T00:00:00Z",
      "imageUrl": null,
      "transcriptionStatus": "ready",
      "lessonStatus": "ready",
      "hasAudioMirror": true
    }
  ]
}
```

#### `GET /podcast-feeds/episodes/:episodeId`
Détail complet : transcript + dialogue + lesson pack. C'est la payload principale consommée par l'app.

**Réponse 200 :** `PodcastEpisodeFull` (voir Types)
```json
{
  "id": "ep_abc123",
  "feed": { "id": "bbc-6min", "title": "6 Minute English", "kind": "conversation", "cefrLevelHint": "B1-B2" },
  "title": "Why do we laugh?",
  "description": "...",
  "durationSec": 360,
  "publishedAt": "2026-06-15T00:00:00Z",
  "audioUrl": "https://.../original.mp3",
  "audioKey": "podcasts/episodes/ep_abc123.mp3",
  "transcriptionStatus": "ready",
  "transcriptText": "Hello and welcome to 6 Minute English...",
  "dialogue": [
    { "speaker": "speaker_0", "text": "Hello and welcome to 6 Minute English.", "start": 0.0, "end": 3.2 },
    { "speaker": "speaker_1", "text": "Hi Neil.", "start": 3.4, "end": 4.1 }
  ],
  "lesson": {
    "level": "B1",
    "summaryFr": "Sam et Neil explorent pourquoi nous rions...",
    "readingLevels": { /* voir ReadingLessonPack */ },
    "signals": [ /* signaux discursifs extraits du texte */ ],
    "grammarPoints": [ /* patterns émergents du texte */ ],
    "vocabulary": [ /* mots-clés en contexte, prêts pour SRS */ ],
    "quizzes": { /* skim/scan/deep */ }
  }
}
```

#### `POST /podcast-feeds/episodes/:episodeId/transcribe`
Déclenche la transcription Deepgram. Peut être long (jusqu'à 120s timeout Deepgram).
Pour les longs épisodes, le worker mirror l'audio R2 d'abord puis transcrit.

**Flow :**
1. Fetch `audio_url` → R2 (`podcasts/episodes/<id>.mp3`)
2. `transcription_status = 'transcribing'`
3. `transcribeWithDeepgram(env, { audio, minSpeakers: 2, maxSpeakers: 4 })`
4. Stock `transcript_text` + `dialogue_json`
5. `transcription_status = 'ready'`

**Réponse 200 :** `{ ok: true, transcriptionStatus: "ready", dialogue: [...] }`
**Réponse 202 :** (si async) `{ ok: true, transcriptionStatus: "transcribing" }`

#### `GET /podcast-feeds/episodes/:episodeId/transcription-status`
Poll pour suivre la transcription.
**Réponse 200 :** `{ "status": "transcribing", "provider": "deepgram" }`

#### `POST /podcast-feeds/episodes/:episodeId/lesson`
Génère le Reading Lesson Pack depuis le transcript (LLM : Gemini → DeepSeek fallback).
**Réponse 200 :** `{ ok: true, lesson: ReadingLessonPack }`

#### `GET /podcast-feeds/episodes/:episodeId/lesson`
Récupère le lesson pack déjà généré (cache D1).
**Réponse 200 :** `ReadingLessonPack`
**Réponse 404 :** si pas encore généré.

---

### Recommandation (principe de Krashen i+1)

#### `GET /podcast-feeds/recommend`
Épisodes dont le vocabulaire inconnu est dans la zone optimale d'apprentissage,
calculé en croisant `transcript_text` × `word_progress` du profil.

**Query :** `?profileId=<id>&kind=conversation&limit=10`
**Réponse 200 :**
```json
{
  "episodes": [
    {
      "id": "ep_abc123",
      "feedId": "bbc-6min",
      "title": "Why do we laugh?",
      "kind": "conversation",
      "cefrLevelHint": "B1-B2",
      "estimatedKnownRatio": 0.82,
      "estimatedUnknownCount": 14,
      "publishedAt": "2026-06-15T00:00:00Z",
      "lessonStatus": "ready"
    }
  ]
}
```

**Logique de scoring (côté worker) :**
1. Tokenize `transcript_text` (mots uniques, lemmatisés).
2. Pour chaque episode candidat (`lesson_status = 'ready'`), calcule :
   - `knownCount` = tokens présents dans `word_progress` du profil avec `level >= 2`
   - `unknownCount` = tokens absents ou `level < 2`
   - `knownRatio = knownCount / totalUniqueTokens`
3. Filtre : `knownRatio` entre 0.75 et 0.92 (zone i+1).
4. Tri : `unknownCount` asc (priorité aux épisodes avec peu de nouveau) puis `publishedAt` desc.

---

### Audio (shadowing)

#### `GET /audio/podcasts/episodes/:episodeId`
Sert l'audio mirroré depuis R2 avec support `Range` (requis pour le seek par timestamps).
Réutilise `handleServeAudio` existant avec la key `podcasts/episodes/<id>.mp3`.

Si pas mirroré, l'app peut streamer directement `audioUrl` source (mais sans Range garanti selon l'hébergeur).

---

## Types partagés

Voir `src/podcastFeeds.ts` (worker) et `src/types/podcastFeed.ts` (app) — miroirs identiques.

### `ReadingLessonPack` — le cœur pédagogique

```typescript
interface ReadingLessonPack {
  level: string;                    // CEFR détecté : A1-C1
  summaryFr: string;                // résumé court en français (≤ 30 mots)
  readingLevels: {
    skim:  { focus: string; question: string; answer: string };
    scan:  { focus: string; items: { question: string; answer: string }[] };
    deep:  { questions: { question: string; answer: string; type: 'literal' | 'inferential' | 'critical' }[] };
  };
  signals: DiscourseSignal[];       // marqueurs extraits DU texte
  grammarPoints: EmergentGrammar[]; // patterns détectés DANS le texte
  vocabulary: ContextVocab[];       // prêts pour SRS
  collocations: { phrase: string; meaningFr: string; example: string }[];
  shadowingPrompts?: string[];      // pour conversations : 3-5 phrases-clés à répéter
}

interface DiscourseSignal {
  token: string;          // "gonna", "on the other hand", "I mean", "well"
  category: 'filler' | 'connector' | 'hedge' | 'reformulation' | 'backchannel' | 'liaison' | 'discourse_marker';
  functionFr: string;     // rôle pragmatique en français (≤ 12 mots)
  exampleInText: string;  // phrase exacte du transcript où ça apparaît
  register: 'formal' | 'informal' | 'neutral';
}

interface EmergentGrammar {
  pattern: string;        // "Present perfect continuous"
  structureFr: string;    // explication courte en français (≤ 20 mots)
  exampleInText: string;  // phrase exacte du transcript
  why: string;            // pourquoi on l'utilise ici (≤ 15 mots)
}

interface ContextVocab {
  term: string;
  definitionFr: string;   // ≤ 8 mots
  example: string;        // phrase anglaise (préférée : issue du transcript)
  cefrLevel: string;
  register?: 'formal' | 'informal' | 'neutral';
}
```

### `PodcastEpisodeFull` — payload complète consommée par l'app

```typescript
interface PodcastEpisodeFull {
  id: string;
  feed: { id: string; title: string; kind: 'conversation' | 'news' | 'tech'; cefrLevelHint: string | null };
  title: string;
  description: string;
  durationSec: number;
  publishedAt: string;
  audioUrl: string;            // source
  audioKey: string | null;     // R2 mirror (pour Range/shadowing)
  transcriptionStatus: 'pending' | 'transcribing' | 'ready' | 'failed';
  transcriptText: string | null;
  dialogue: DialogueLine[] | null;   // null si ce n'est pas une conversation
  lesson: ReadingLessonPack | null;
}

interface DialogueLine {
  speaker: string;   // "speaker_0", "speaker_1"
  text: string;
  start: number;     // secondes
  end: number;
}
```

---

## Flow complet (sequence)

1. **Setup** : `POST /podcast-feeds` (ajoute BBC 6 Min + Leonardo) → scan RSS → 30 épisodes `pending` chacun.
2. **Transcription** : `POST /podcast-feeds/episodes/:id/transcribe` → mirror R2 → Deepgram → `dialogue_json` + `transcript_text` → `transcription_status: ready`.
3. **Lesson** : `POST /podcast-feeds/episodes/:id/lesson` → LLM génère `ReadingLessonPack` depuis transcript → `lesson_status: ready`.
4. **Consommation app** : `GET /podcast-feeds/recommend?kind=conversation` → l'app affiche les épisodes dans `Lire`.
5. **Lecture** : `GET /podcast-feeds/episodes/:id` → l'app affiche transcript (ou dialogue diarisé) + lesson pack (signaux, grammaire, vocab, quiz).
6. **Shadowing** : `GET /audio/podcasts/episodes/:id` avec Range → seek par timestamp de réplique.
7. **SRS** : `POST /articles/promote-words` (réutilisé) avec `vocabulary` du lesson pack → SRS.
8. **Mémoire pédagogique** : `POST /learning/events` avec `module: 'lire'`, `skill: 'reading'`, `linguisticSignals: [...]` → Insights.

---

## Prompts LLM (guidelines, à affiner lors de l'implémentation)

### Génération du lesson pack

**System :** "You are an English teacher for French speakers. From the given English transcript, extract a reading lesson pack. CRITICAL: every signal, grammar point, and vocabulary example MUST come from the actual transcript text — never invent examples. Detect the CEFR level from the vocabulary density."

**User :** fournit `transcriptText` (+ `dialogue` si conversation) + `cefrLevelHint`.

**Sortie JSON** structurée selon `ReadingLessonPack`.

### Spécifique conversations

Quand `kind === 'conversation'`, le prompt demande en plus :
- focus sur les signaux conversationnels (fillers, backchannels, turn-taking)
- `shadowingPrompts` : 3-5 phrases naturelles à répéter
- détection des liaisons/élisions ("gonna", "wanna", "kinda", "'ve got", "y'know")
- register informel mis en avant

---

## Limites / coûts

- **Deepgram Nova-3** : ~$0.0043/min audio. Un épisode 6min = ~$0.026. Budget initial : transcrire 50 épisodes = ~$1.3.
- **LLM lesson pack** : Gemini Flash ~$0.0001/call. Négligeable.
- **R2 storage** : ~5MB/épisode mirroré. 100 épisodes = 500MB (largement dans le free tier).
- **Latence transcription** : 6min audio ≈ 30-60s Deepgram. Acceptable synchrone pour usage perso.

## TODO implémentation (ordres suggérés)

1. [worker] Migration 0010 + `src/podcastFeeds.ts` (types + handlers stubs)
2. [worker] `POST /podcast-feeds` + RSS parser (fast-xml-parser ou custom)
3. [worker] `POST .../transcribe` réutilisant `transcribeWithDeepgram`
4. [worker] `POST .../lesson` (LLM prompt + parsing JSON)
5. [worker] `GET /podcast-feeds/recommend` (scoring i+1)
6. [app] `src/types/podcastFeed.ts` + `src/services/podcastFeedService.ts`
7. [app] `usePodcastFeedLibrary` hook + composant `ConversationReader`
8. [app] Intégration dans `lire.tsx` (onglet "Conversations")

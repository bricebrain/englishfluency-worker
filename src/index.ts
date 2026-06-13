import type { Env } from './types';
import { json, err } from './utils';
import { handleProxy } from './proxy';
import { handleGetProfile, handleCreateProfile, handleListProfiles, handleDeleteProfile } from './profile';
import { handleGetSrsProgress, handleSrsReview, handleSrsPromote, handleSrsStats, handleSrsSession, handleSrsCalibrate } from './srs';
import { handleGetContent, handleCreateContent, handleDeleteContent, handlePatchContent } from './content';
import { handleGetDictation, handleSaveDictation } from './dictation';
import {
  handleGetLingvistCard, handleGetLingvistCards, handleUpsertLingvistCard,
  handleGetCalibration, handleSaveCalibration, handleDeleteCalibration,
} from './lingvist';
import { handleLingvistPrepare, handleLingvistSession } from './lingvistSession';
import { handleTtsOpenAi, handleTtsGemini, handleTtsGroq, handleServeAudio } from './tts';
import { handleYouTubeSearch, handleYouTubeVideos } from './youtube';
import {
  handleGetWords, handleGetCount, handleSync, handleGetWord,
  handlePatchAudio, handleRandom, handleGrammarSeed,
} from './vocabulary';
import { handleArticleLesson, handleAnswerFeedback, handlePromoteWords } from './articles';
import { handleGetReadingSources } from './readingSources';
import { handleQrGenerate, handleQrAnalyze } from './qr';
import { handleSpeakAnalyze } from './speak';
import { handlePromoteSpeakFeedback } from './speakRecycle';
import { handlePromotePodcastWords } from './podcastRecycle';
import { handleGetDailyPodcast, handleGeneratePodcast, generateAndStoreDailyPodcast } from './podcast';
import {
  handleGetChannelLesson,
  handleListChannels,
  handleAddChannel,
  handleToggleChannel,
  handleDeleteChannel,
} from './channelLessons';
import { handleGetDailyMission, handleGetLearningInsights, handleTrackLearningEvent } from './learning';
import {
  handleAssimilRunPodStatus,
  handleAssimilLessons,
  handleGenerateAssimilLesson,
  handleGetAssimilLesson,
  handleTranscribeAssimilLesson,
  handleUpsertAssimilTranscript,
} from './assimil';

export default {
  // ── Cron — podcast du jour (7h / 12h / 18h UTC) ─────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await generateAndStoreDailyPodcast(env, 'B1').catch(() => {/* silently fail */});
  },

  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    // ── CORS preflight ───────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // ── Health ───────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/') {
      return json({ app: 'englishfluency-worker', status: 'ok', version: '2.0.0' });
    }

    // ── AI Proxy ─────────────────────────────────────────────────────────
    if (path.startsWith('/proxy/')) {
      return handleProxy(req, env, path.slice('/proxy/'.length));
    }

    // ── YouTube proxy ────────────────────────────────────────────────────
    if (method === 'GET' && path === '/youtube/search') return handleYouTubeSearch(req, env);
    if (method === 'GET' && path === '/youtube/videos') return handleYouTubeVideos(req, env);

    // ── TTS + Audio R2 ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/tts/openai')  return handleTtsOpenAi(req, env);
    if (method === 'POST' && path === '/tts/gemini')  return handleTtsGemini(req, env);
    if (method === 'POST' && path === '/tts/groq')    return handleTtsGroq(req, env);
    if (method === 'GET'  && path.startsWith('/audio/')) {
      // /audio/tts/openai/abc.mp3  → key = tts/openai/abc.mp3
      const key = path.slice('/audio/'.length);
      return handleServeAudio(req, env, key);
    }
    if (method === 'GET' && path === '/assimil/lessons') return handleAssimilLessons(req, env);
    if (method === 'GET' && path === '/assimil/runpod/status') return handleAssimilRunPodStatus(req, env);
    if (method === 'GET' && path.match(/^\/assimil\/lesson\/\d+$/)) {
      return handleGetAssimilLesson(req, env, path.split('/')[3]);
    }
    if (method === 'PUT' && path.match(/^\/assimil\/lesson\/\d+\/transcript$/)) {
      return handleUpsertAssimilTranscript(req, env, path.split('/')[3]);
    }
    if (method === 'POST' && path.match(/^\/assimil\/lesson\/\d+\/transcribe$/)) {
      return handleTranscribeAssimilLesson(req, env, path.split('/')[3]);
    }
    if (method === 'POST' && path.match(/^\/assimil\/lesson\/\d+\/generate$/)) {
      return handleGenerateAssimilLesson(req, env, path.split('/')[3]);
    }

    // ── Profils ──────────────────────────────────────────────────────────
    if (method === 'GET'    && path === '/profiles')          return handleListProfiles(req, env);
    if (method === 'GET'    && path === '/profile')           return handleGetProfile(req, env);
    if (method === 'POST'   && path === '/profile')           return handleCreateProfile(req, env);
    if (method === 'DELETE' && path.match(/^\/profile\/[^/]+$/)) {
      return handleDeleteProfile(req, env, path.split('/')[2]);
    }

    // ── SRS ──────────────────────────────────────────────────────────────
    if (method === 'GET'  && path === '/srs/session')   return handleSrsSession(req, env);
    if (method === 'GET'  && path === '/srs/stats')     return handleSrsStats(req, env);
    if (method === 'POST' && path === '/srs/review')    return handleSrsReview(req, env);
    if (method === 'POST' && path === '/srs/calibrate') return handleSrsCalibrate(req, env);

    // ── Mémoire pédagogique ──────────────────────────────────────────────
    if (method === 'GET'  && path === '/learning/mission') return handleGetDailyMission(req, env);
    if (method === 'GET'  && path === '/learning/insights') return handleGetLearningInsights(req, env);
    if (method === 'POST' && path === '/learning/events')  return handleTrackLearningEvent(req, env);
    // Legacy (admin/debug)
    if (method === 'GET'  && path === '/srs/progress')  return handleGetSrsProgress(req, env);
    if (method === 'POST' && path === '/srs/promote')   return handleSrsPromote(req, env);

    // ── Contenu IA ───────────────────────────────────────────────────────
    if (method === 'GET'    && path === '/content')              return handleGetContent(req, env);
    if (method === 'POST'   && path === '/content')              return handleCreateContent(req, env);
    if (method === 'DELETE' && path.match(/^\/content\/[^/]+$/)) return handleDeleteContent(req, env, path.split('/')[2]);
    if (method === 'PATCH'  && path.match(/^\/content\/[^/]+$/)) return handlePatchContent(req, env, path.split('/')[2]);

    // ── Dictée ───────────────────────────────────────────────────────────
    if (method === 'GET'  && path === '/dictation') return handleGetDictation(req, env);
    if (method === 'POST' && path === '/dictation') return handleSaveDictation(req, env);

    // ── Lingvist ─────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/lingvist/session') return handleLingvistSession(req, env);
    if (method === 'POST' && path === '/lingvist/prepare') return handleLingvistPrepare(req, env);
    if (method === 'GET' && path === '/lingvist/cards') return handleGetLingvistCards(req, env);
    if (method === 'GET' && path.match(/^\/lingvist\/card\/[^/]+$/)) {
      return handleGetLingvistCard(req, env, path.split('/')[3]);
    }
    if (method === 'PUT' && path.match(/^\/lingvist\/card\/[^/]+$/)) {
      return handleUpsertLingvistCard(req, env, path.split('/')[3]);
    }

    // ── Calibration ──────────────────────────────────────────────────────
    if (method === 'GET'    && path === '/calibration') return handleGetCalibration(req, env);
    if (method === 'POST'   && path === '/calibration') return handleSaveCalibration(req, env);
    if (method === 'DELETE' && path === '/calibration') return handleDeleteCalibration(req, env);

    // ── Articles — feed + leçon IA + correction réponse ─────────────────
    if (method === 'POST' && path === '/articles/lesson')         return handleArticleLesson(req, env);
    if (method === 'POST' && path === '/articles/feedback')        return handleAnswerFeedback(req, env);
    if (method === 'POST' && path === '/articles/promote-words')   return handlePromoteWords(req, env);

    // ── Podcasts du jour (cron + on-demand) ─────────────────────────────────
    if (method === 'GET'  && path === '/podcasts/daily')    return handleGetDailyPodcast(req, env);
    if (method === 'POST' && path === '/podcasts/generate') return handleGeneratePodcast(req, env);
    if (method === 'POST' && path === '/podcasts/promote-words') return handlePromotePodcastWords(req, env);

    // ── Leçons YouTube (BBC Learning English / engVid) ───────────────────────
    if (method === 'GET'    && path === '/lessons/channel')              return handleGetChannelLesson(req, env);

    // ── Admin : gestion des chaînes YouTube ──────────────────────────────────
    if (method === 'GET'    && path === '/admin/channels')               return handleListChannels(req, env);
    if (method === 'POST'   && path === '/admin/channels')               return handleAddChannel(req, env);
    if (method === 'PATCH'  && path.startsWith('/admin/channels/'))      return handleToggleChannel(req, env, path.slice('/admin/channels/'.length));
    if (method === 'DELETE' && path.startsWith('/admin/channels/'))      return handleDeleteChannel(req, env, path.slice('/admin/channels/'.length));

    // ── Q&R — expression écrite guidée ────────────────────────────────────
    if (method === 'POST' && path === '/qr/generate') return handleQrGenerate(req, env);
    if (method === 'POST' && path === '/qr/analyze')  return handleQrAnalyze(req, env);

    // ── Parler — transcription + analyse vocale ───────────────────────────
    if (method === 'POST' && path === '/speak/analyze') return handleSpeakAnalyze(req, env);
    if (method === 'POST' && path === '/speak/promote-feedback') return handlePromoteSpeakFeedback(req, env);
    if (method === 'GET' && path === '/articles') return handleGetReadingSources(req);

    // ── Vocabulary (existant) ─────────────────────────────────────────────
    if (method === 'GET' && path === '/words/count')        return handleGetCount(env);
    if (method === 'GET' && path === '/words/sync')         return handleSync(req, env);
    if (method === 'GET' && path === '/words/random')       return handleRandom(req, env);
    if (method === 'GET' && path === '/words/grammar-seed') return handleGrammarSeed(req, env);
    if (method === 'GET' && path === '/words')              return handleGetWords(req, env);
    if (method === 'GET' && path.match(/^\/words\/[^/]+$/)) {
      return handleGetWord(path.split('/')[2], env);
    }
    if (method === 'PATCH' && path.match(/^\/words\/[^/]+\/audio$/)) {
      return handlePatchAudio(req, path.split('/')[2], env);
    }

    return err('Route inconnue', 404);
  },
};

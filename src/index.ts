import type { Env } from './types';
import { json, err } from './utils';
import { handleProxy } from './proxy';
import { handleGetProfile, handleCreateProfile, handleListProfiles, handleDeleteProfile } from './profile';
import { handleGetSrsProgress, handleSrsReview, handleSrsPromote, handleSrsStats, handleSrsSession, handleSrsCalibrate } from './srs';
import { handleGetContent, handleCreateContent, handleDeleteContent, handlePatchContent } from './content';
import { handleGetDictation, handleSaveDictation } from './dictation';
import {
  handleGetLingvistCards, handleUpsertLingvistCard,
  handleGetCalibration, handleSaveCalibration, handleDeleteCalibration,
} from './lingvist';
import { handleTtsOpenAi, handleTtsGemini, handleTtsGroq, handleServeAudio } from './tts';
import { handleYouTubeSearch, handleYouTubeVideos } from './youtube';
import {
  handleGetWords, handleGetCount, handleSync, handleGetWord,
  handlePatchAudio, handleRandom, handleGrammarSeed,
} from './vocabulary';
import { handleArticleLesson, handleAnswerFeedback, handlePromoteWords } from './articles';
import { handleQrGenerate, handleQrAnalyze } from './qr';

export default {
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
    if (method === 'GET' && path === '/lingvist/cards') return handleGetLingvistCards(req, env);
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

    // ── Q&R — expression écrite guidée ────────────────────────────────────
    if (method === 'POST' && path === '/qr/generate') return handleQrGenerate(req, env);
    if (method === 'POST' && path === '/qr/analyze')  return handleQrAnalyze(req, env);
    if (method === 'GET' && path === '/articles') {
      const hours = url.searchParams.get('hours') ?? '24';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '15'), 30);
      // Appel zéro-latence via Service Binding (pas de HTTP externe)
      return env.TECHPULSE.fetch(
        new Request(`http://techpulse/articles/recent?hours=${hours}&limit=${limit}`),
      );
    }

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

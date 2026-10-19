import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

type Receipt = { payload_hash: string; word_id: string; status: string };
const normalize = (s: string) => s.trim().replace(/\s+/gu,' ').toLowerCase();
async function hash(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),(b)=>b.toString(16).padStart(2,'0')).join('');
}
async function body(req: Request): Promise<Record<string,unknown>|null> {
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size=0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>20_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset=0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    const b: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return b && typeof b==='object' && !Array.isArray(b) ? b as Record<string,unknown> : null;
  } catch { return null; } finally { reader.releaseLock(); }
}
export async function handleVocabularyPick(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req,env.API_SECRET)) return err('Non autorisé',401);
  const b = await body(req);
  if (!b) return err('Sélection invalide');
  for (const [key,max] of [['sourceId',100],['profileId',100],['word',120],['sentence',4000],
    ['contentId',96],['publicationId',36],['variantKey',32]] as const) {
    if (typeof b[key]!=='string' || !b[key].trim() || b[key].length>max) return err('Sélection invalide');
  }
  const word=normalize(String(b.word)), sentence=String(b.sentence).trim();
  if (b.language!=='en' || word.split(' ').length>8 || !normalize(sentence).includes(word) ||
      !Number.isSafeInteger(b.segmentIndex) || Number(b.segmentIndex)<0 ||
      !/^discover:[0-9a-f-]{36}$/.test(String(b.sourceId))) return err('Sélection invalide');
  if (!await env.DB.prepare('SELECT id FROM profiles WHERE id=?').bind(b.profileId).first()) return err('Profil introuvable',404);
  const context = {word,sentence,contentId:b.contentId,publicationId:b.publicationId,
    variantKey:b.variantKey,segmentIndex:b.segmentIndex,language:'en'};
  const fingerprint=await hash(JSON.stringify(context));
  const receipt = () => env.DB.prepare('SELECT * FROM vocabulary_pick_receipts WHERE profile_id=? AND source_id=?')
    .bind(b.profileId,b.sourceId).first<Receipt>();
  const response = (r: Receipt) => r.payload_hash===fingerprint
    ? json({ok:true,status:r.status,wordId:r.word_id}) : err('Sélection déjà reçue avec un autre contenu',409);
  const previous = await receipt();
  if (previous) return response(previous);
  const known = await env.DB.prepare(`SELECT id FROM words WHERE lower(trim(mot))=? ORDER BY id LIMIT 1`).bind(word).first<{id:string}>();
  const candidate=known?.id ?? 'discover-'+await hash(word);
  const now = new Date().toISOString();
  // Lot atomique : clé canonique, reçu, exemple et mot sont publiés ensemble.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO words (id,mot,type,niveau,traduction,tags,updated_at)
      SELECT ?,?,?, 'B1','', '["discover"]',? WHERE NOT EXISTS
      (SELECT 1 FROM vocabulary_pick_words WHERE normalized_word=?)`)
      .bind(candidate,String(b.word).trim().replace(/\s+/gu,' '),word.includes(' ') ? 'expression' : 'word',now,word),
    env.DB.prepare('INSERT OR IGNORE INTO vocabulary_pick_words(normalized_word,word_id) VALUES (?,?)').bind(word,candidate),
    env.DB.prepare(`INSERT OR IGNORE INTO vocabulary_pick_receipts
      (profile_id,source_id,payload_hash,word_id,status,context,created_at)
      SELECT ?,?,?,word_id,?,?,? FROM vocabulary_pick_words WHERE normalized_word=?`)
      .bind(b.profileId,b.sourceId,fingerprint,known ? 'already_known' : 'sent',JSON.stringify(context),now,word),
    env.DB.prepare(`INSERT OR IGNORE INTO word_progress
      (id,profile_id,word_id,prochaine_revision,repetitions,level,status)
      SELECT ? || '_' || word_id,?,word_id,datetime('now'),1,1,'learning'
      FROM vocabulary_pick_receipts WHERE profile_id=? AND source_id=? AND payload_hash=?
      AND NOT EXISTS (SELECT 1 FROM word_progress wp WHERE wp.profile_id=? AND wp.word_id=vocabulary_pick_receipts.word_id)`)
      .bind(b.profileId,b.profileId,b.profileId,b.sourceId,fingerprint,b.profileId),
    env.DB.prepare(`UPDATE words SET examples=json_insert(examples,'$[#]',json_object('en',?,'fr','')),updated_at=?
      WHERE id=(SELECT word_id FROM vocabulary_pick_receipts WHERE profile_id=? AND source_id=? AND payload_hash=?)
      AND NOT EXISTS (SELECT 1 FROM json_each(words.examples) WHERE json_extract(value,'$.en')=?)`)
      .bind(sentence,now,b.profileId,b.sourceId,fingerprint,sentence),
  ]);
  const saved = await receipt();
  if (!saved) return err('Réception indisponible',503);
  return response(saved);
}

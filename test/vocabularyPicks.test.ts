import fixture from './fixtures/vocabulary-pick.json';
import { expect, it } from 'vitest';
import { call, createEnv as baseEnv } from './support/env';

function createEnv() {
  const result=baseEnv();
  result.db.sqlite.prepare("INSERT INTO profiles(id,name) VALUES ('default','Test')").run();
  return result;
}
const payload = (word='zesty new phrase') => ({...fixture,sourceId:'discover:'+crypto.randomUUID(),profileId:'default',
  word,sentence:`We use ${word} today.`,contentId:'sample-content',publicationId:crypto.randomUUID(),
  variantKey:'en-source',segmentIndex:0,language:'en'});
it('authentifie et valide les sélections et le profil',async()=>{
  const {env}=createEnv(), b=payload();
  expect((await call(env,'/words/picks',{method:'POST',auth:false,body:b})).status).toBe(401);
  for (const body of [null,[],{}, {...b,language:'fr'},{...b,segmentIndex:true},{...b,sentence:'Absent'}]) {
    expect((await call(env,'/words/picks',{method:'POST',body})).status).toBe(400);
  }
  expect((await call(env,'/words/picks',{method:'POST',body:{...b,profileId:'missing'}})).status).toBe(404);
});
it('crée un seul mot, conserve le reçu et refuse un rejeu différent',async()=>{
  const {env,db}=createEnv(), b=payload();
  const first=await (await call(env,'/words/picks',{method:'POST',body:b})).json();
  expect(first).toMatchObject({ok:true,status:'sent'});
  expect(db.sqlite.prepare('SELECT repetitions,status FROM word_progress WHERE word_id=?').get(first.wordId)).toMatchObject({repetitions:1,status:'learning'});
  expect(await (await call(env,'/words/picks',{method:'POST',body:b})).json()).toEqual(first);
  const row=db.sqlite.prepare('SELECT * FROM words WHERE id=?').get(first.wordId) as {examples:string};
  expect(JSON.parse(row.examples)).toEqual([{en:b.sentence,fr:''}]);
  expect((await call(env,'/words/picks',{method:'POST',body:{...b,sentence:b.sentence+' Again.'}})).status).toBe(409);
  expect((await call(env,'/words/picks',{method:'POST',body:{...b,sourceId:'discover:'+crypto.randomUUID()}})).status).toBe(200);
  expect(JSON.parse((db.sqlite.prepare('SELECT examples FROM words WHERE id=?').get(first.wordId) as {examples:string}).examples)).toHaveLength(1);
});
it('rattache un mot connu sans écraser le SRS ni son enrichissement',async()=>{
  const {env,db}=createEnv();
  const word=db.sqlite.prepare('SELECT id,mot FROM words ORDER BY id LIMIT 1').get() as {id:string;mot:string};
  db.sqlite.prepare(`INSERT INTO word_progress(id,profile_id,word_id,prochaine_revision,repetitions)
    VALUES (?,'default',?,'2030-01-01',5)`).run('default_'+word.id,word.id);
  const before=db.sqlite.prepare('SELECT * FROM word_progress').all();
  const b=payload(word.mot.toUpperCase());
  expect(await (await call(env,'/words/picks',{method:'POST',body:b})).json()).toMatchObject({status:'already_known',wordId:word.id});
  expect(db.sqlite.prepare('SELECT * FROM word_progress').all()).toEqual(before);
  expect(await (await call(env,'/words/'+word.id)).json()).toBeTruthy();
});
it('récupère après perte de réponse et conserve deux contextes pour un seul mot',async()=>{
  const {env,db}=createEnv(), a=payload();
  const first=await (await call(env,'/words/picks',{method:'POST',body:a})).json();
  const b={...a,sourceId:'discover:'+crypto.randomUUID(),sentence:a.sentence+' Again.'};
  expect(await (await call(env,'/words/picks',{method:'POST',body:b})).json()).toMatchObject({status:'already_known',wordId:first.wordId});
  expect(await (await call(env,'/words/picks',{method:'POST',body:a})).json()).toEqual(first);
  expect(JSON.parse((db.sqlite.prepare('SELECT examples FROM words WHERE id=?').get(first.wordId) as {examples:string}).examples)).toHaveLength(2);
});

it('accepte la fixture partagée TS/Python',async()=>{
  const {env}=createEnv();
  expect((await call(env,'/words/picks',{method:'POST',body:fixture})).status).toBe(200);
});

it('annule tout le lot si le rattachement de la phrase échoue',async()=>{
  const {env,db}=createEnv(), b=payload('atomic selection phrase');
  db.sqlite.exec(`CREATE TRIGGER reject_pick_example BEFORE UPDATE OF examples ON words
    BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;`);
  await expect(call(env,'/words/picks',{method:'POST',body:b})).rejects.toThrow('simulated storage failure');
  expect(db.sqlite.prepare('SELECT id FROM words WHERE mot=?').get(b.word)).toBeUndefined();
  expect(db.sqlite.prepare('SELECT source_id FROM vocabulary_pick_receipts').all()).toHaveLength(0);
  expect(db.sqlite.prepare('SELECT id FROM word_progress').all()).toHaveLength(0);
});

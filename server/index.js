import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { initDb, q, one } from './db.js';
import { initStorage, storage, originalKey, thumbKey } from './storage.js';
import { subscribe } from './events.js';
import { startRun } from './pipeline/run.js';
import { loadArbitrationNodes } from './pipeline/nodes.js';
import { postToWebhook } from './discord.js';
import { loadFrames, matchFrame, frameIcon } from './frames.js';

await initDb();
await initStorage();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

const intParam = v => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Every browser gets an anonymous id in a cookie, and jobs belong to the browser that started them,
// so a public deployment never shows one visitor's docs to another.
const COOKIE = 'ds_vid';
app.use((req, res, next) => {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})`).exec(req.headers.cookie ?? '');
  req.visitor = m?.[1];
  if (!req.visitor) {
    req.visitor = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE, req.visitor, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 365 * 24 * 3600 * 1000 });
  }
  next();
});

// Jobs made before ownership existed (local development only) go to the first browser that asks.
app.use(async (req, _res, next) => {
  if (req.path.startsWith('/api/')) await q('update runs set owner = $1 where owner is null', [req.visitor]);
  next();
});

const ownRun = (req, id) => one('select * from runs where id = $1 and owner = $2', [id, req.visitor]);
const ownEntry = (req, id) => one('select e.* from entries e join runs r on r.id = e.run_id where e.id = $1 and r.owner = $2', [id, req.visitor]);
const ownHash = (req, hash) => one('select i.mime from images i join runs r on r.id = i.run_id where i.hash = $1 and r.owner = $2 limit 1', [hash, req.visitor]);

// A few jobs at a time per browser, and a ceiling per hour: one big doc is ~140 MB of download.
const MAX_ACTIVE = 2;
const MAX_PER_HOUR = 20;
const startedAt = new Map(); // visitor -> timestamps of recent starts

app.post('/api/runs', async (req, res) => {
  const { link, preset, readMapNames } = req.body ?? {};
  if (typeof link !== 'string' || !link.trim()) return res.status(400).json({ error: 'Paste a Google Doc link first.' });
  const recent = (startedAt.get(req.visitor) ?? []).filter(t => Date.now() - t < 3600_000);
  const active = await one("select count(*)::int as n from runs where owner = $1 and status = 'running'", [req.visitor]);
  if (active.n >= MAX_ACTIVE) return res.status(429).json({ error: `You already have ${active.n} jobs running. Wait for one to finish, then start this one.` });
  if (recent.length >= MAX_PER_HOUR) return res.status(429).json({ error: `That's ${MAX_PER_HOUR} jobs this hour. Try again in a little while; your earlier jobs are all still here.` });
  startedAt.set(req.visitor, [...recent, Date.now()]);
  const id = await startRun({ link: link.trim(), owner: req.visitor, preset: preset === 'warframe' ? 'warframe' : 'plain', readMapNames: readMapNames !== false });
  res.json({ id });
});

app.get('/api/config', (_req, res) => res.json({ sampleDoc: process.env.SAMPLE_DOC_URL || null }));

app.get('/api/runs', async (req, res) => {
  res.json(await q('select id, doc_id, link, title, preset, status, stats, error, started_at, finished_at from runs where owner = $1 order by id desc limit 50', [req.visitor]));
});

app.get('/api/runs/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const run = await ownRun(req, id);
  if (!run) return res.status(404).json({ error: 'This job does not exist, or it was started in another browser.' });
  delete run.owner;
  const [events, sections, entries, images] = await Promise.all([
    q('select seq, at_ms as at, step, status, detail, duration_ms as duration, data from events where run_id = $1 order by seq', [id]),
    q('select id, idx, title, notes from sections where run_id = $1 order by idx', [id]),
    q('select id, section_id, idx, number, kind, text, notes, flags, map_guess, map_label from entries where run_id = $1 order by idx', [id]),
    q('select id, entry_id, ord, hash, mime, width, height, bytes, excluded, flags from images where run_id = $1 order by entry_id, ord', [id]),
  ]);
  if (run.preset === 'warframe') {
    try {
      const frames = await loadFrames();
      for (const s of sections) {
        const f = matchFrame(s.title, frames);
        if (f) s.frame = { name: f.name, icon: `/frame-icon/${encodeURIComponent(f.image)}` };
      }
    } catch { /* no portraits is fine; the headings still work */ }
  }
  res.json({ run, events, sections, entries, images });
});

app.get('/frame-icon/:image', async (req, res) => {
  try {
    const icon = await frameIcon(req.params.image);
    if (!icon) return res.status(404).end();
    res.set({ 'content-type': 'image/webp', 'cache-control': 'public, max-age=604800' }).send(icon);
  } catch {
    res.status(502).end();
  }
});

// Live events for a running job (server-sent events).
app.get('/api/runs/:id/stream', async (req, res) => {
  const id = intParam(req.params.id);
  if (!(await ownRun(req, id))) return res.status(404).end();
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const off = subscribe(id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); off(); });
});

app.patch('/api/entries/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (!(await ownEntry(req, id))) return res.status(404).json({ error: 'No such entry' });
  const { mapLabel, number, text } = req.body ?? {};
  const row = await one(
    `update entries set map_label = case when $2::boolean then $3 else map_label end,
       number = coalesce($4, number), text = coalesce($5, text) where id = $1 returning id, map_label, number, text`,
    [id, mapLabel !== undefined, typeof mapLabel === 'string' ? mapLabel.slice(0, 120) || null : null, number ?? null, text ?? null]);
  res.json(row ?? {});
});

// Apply one map label to an entry and every later entry in the same section.
app.post('/api/entries/:id/apply-map-to-rest', async (req, res) => {
  const e = await ownEntry(req, intParam(req.params.id));
  if (!e?.map_label) return res.status(400).json({ error: 'Set a map on this entry first.' });
  const rows = await q("update entries set map_label = $1 where section_id = $2 and idx > $3 and kind = 'item' returning id", [e.map_label, e.section_id, e.idx]);
  res.json({ updated: rows.length });
});

app.patch('/api/images/:id', async (req, res) => {
  const row = await one(
    'update images i set excluded = $2 from runs r where i.id = $1 and r.id = i.run_id and r.owner = $3 returning i.id, i.excluded',
    [intParam(req.params.id), !!req.body?.excluded, req.visitor]);
  res.status(row ? 200 : 404).json(row ?? { error: 'No such image' });
});

app.post('/api/entries/:id/order', async (req, res) => {
  const entryId = intParam(req.params.id);
  if (!(await ownEntry(req, entryId))) return res.status(404).json({ error: 'No such entry' });
  const ids = Array.isArray(req.body?.imageIds) ? req.body.imageIds.map(intParam) : [];
  for (const [ord, imageId] of ids.entries()) await q('update images set ord = $1 where id = $2 and entry_id = $3', [ord, imageId, entryId]);
  res.json({ ok: true });
});

app.get('/api/progress/:runId/:key', async (req, res) => {
  const runId = intParam(req.params.runId);
  if (!(await ownRun(req, runId))) return res.status(404).json({ cursor: 0 });
  const row = await one('select cursor from queue_progress where run_id = $1 and key = $2', [runId, req.params.key.slice(0, 200)]);
  res.json({ cursor: row?.cursor ?? 0 });
});

app.put('/api/progress/:runId/:key', async (req, res) => {
  const runId = intParam(req.params.runId);
  if (!(await ownRun(req, runId))) return res.status(404).json({ error: 'No such job' });
  await q(`insert into queue_progress (run_id, key, cursor, updated_at) values ($1,$2,$3, now())
           on conflict (run_id, key) do update set cursor = excluded.cursor, updated_at = now()`,
  [runId, req.params.key.slice(0, 200), intParam(req.body?.cursor) ?? 0]);
  res.json({ ok: true });
});

app.get('/api/nodes', async (_req, res) => {
  try { res.json((await loadArbitrationNodes()).nodes.map(n => n.label)); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// Images are only served to the browser whose job holds them.
const IMAGE_CACHE = 'private, max-age=31536000, immutable';
app.get('/img/:hash', async (req, res) => {
  const img = await ownHash(req, req.params.hash);
  if (!img) return res.status(404).end();
  res.set({ 'content-type': img.mime, 'cache-control': IMAGE_CACHE }).send(await storage.get(originalKey(req.params.hash, img.mime)));
});
app.get('/thumb/:hash', async (req, res) => {
  if (!(await ownHash(req, req.params.hash))) return res.status(404).end();
  try { res.set({ 'content-type': 'image/webp', 'cache-control': IMAGE_CACHE }).send(await storage.get(thumbKey(req.params.hash))); }
  catch { res.status(404).end(); }
});

const safe = s => String(s ?? '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'section';

// Streamed zip of the chosen sections: files are added one at a time, never buffered as a whole.
app.get('/api/runs/:id/zip', async (req, res) => {
  const id = intParam(req.params.id);
  if (!(await ownRun(req, id))) return res.status(404).end();
  const sectionIds = String(req.query.sections ?? '').split(',').map(intParam).filter(Boolean);
  const rows = await q(
    `select s.title, s.idx as sidx, e.number, e.idx as eidx, i.hash, i.mime, i.ord
     from images i join entries e on e.id = i.entry_id join sections s on s.id = e.section_id
     where i.run_id = $1 and not i.excluded and i.hash is not null ${sectionIds.length ? 'and s.id = any($2)' : ''}
     order by s.idx, e.idx, i.ord`, sectionIds.length ? [id, sectionIds] : [id]);
  res.set({ 'content-type': 'application/zip', 'content-disposition': `attachment; filename="docshots-job-${id}.zip"` });
  const zip = archiver('zip', { store: true });
  zip.on('error', err => res.destroy(err));
  zip.pipe(res);
  const perEntry = new Map();
  for (const r of rows) {
    const k = `${r.sidx}:${r.eidx}`;
    const n = (perEntry.get(k) ?? 0) + 1;
    perEntry.set(k, n);
    const num = String(r.number ?? r.eidx).padStart(3, '0');
    zip.append(await storage.get(originalKey(r.hash, r.mime)), { name: `${safe(r.title)}/${safe(r.title)}_${num}_${n}.${r.mime.split('/')[1]}` });
  }
  await zip.finalize();
});

app.post('/api/discord', async (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? req.body.hashes : [];
  for (const h of hashes) if (!(await ownHash(req, h))) return res.status(404).json({ error: 'One of the images is not in your jobs.' });
  try { res.json(await postToWebhook(req.body ?? {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Housekeeping: jobs older than KEEP_DAYS go, and so do stored images no remaining job points at.
const KEEP_DAYS = Number(process.env.KEEP_DAYS) || 30;
async function cleanUp() {
  try {
    await q(`delete from runs where started_at < now() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
    const orphans = await q("select b.hash, b.mime from blobs b where b.created_at < now() - interval '1 day' and not exists (select 1 from images i where i.hash = b.hash) limit 500");
    for (const b of orphans) {
      await storage.remove(originalKey(b.hash, b.mime));
      await storage.remove(thumbKey(b.hash));
      await q('delete from blobs where hash = $1', [b.hash]);
    }
    if (orphans.length) console.log(`cleanup: removed ${orphans.length} unused images`);
  } catch (err) {
    console.error('cleanup failed', err.message);
  }
}
setInterval(cleanUp, 6 * 3600 * 1000).unref();
setTimeout(cleanUp, 60_000).unref();

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/(api|img|thumb|frame-icon)\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`DocShots on http://localhost:${port} (storage: ${storage.name})`));

// One run: link -> download (streamed) -> structure -> extract -> group -> check -> save -> map names.
// Download, structure and extract overlap: lines are parsed and images saved while bytes are still arriving.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import sharp from 'sharp';
import { q, one } from '../db.js';
import { storage, originalKey, thumbKey } from '../storage.js';
import { createRecorder, broadcast } from '../events.js';
import { DocParser } from './docParser.js';
import { streamExport, parseDocId, DocNotPublicError, TruncatedError, TooLargeError } from './download.js';
import { loadArbitrationNodes } from './nodes.js';
import { createMapReader } from './mapReader.js';

const RETRY_WAIT_MS = [2000, 5000];
const OCR_VERSION = 2; // bump when the map reader changes, so stored readings are redone
const SMALL_PX = 300;
const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const secs = ms => `${(ms / 1000).toFixed(1)} s`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function throttle(fn, ms) {
  let last = 0;
  return (...args) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } };
}

async function saveImage(buf, mime, b64sha1 = null) {
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const key = originalKey(hash, mime);
  const reused = await storage.has(key);
  if (!reused) await storage.put(key, buf);
  const meta = await sharp(buf).metadata();
  if (!(await storage.has(thumbKey(hash)))) {
    await storage.put(thumbKey(hash), await sharp(buf).resize({ width: 320, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer());
  }
  await q(`insert into blobs (hash, b64sha1, mime, width, height, bytes) values ($1,$2,$3,$4,$5,$6)
           on conflict (hash) do update set b64sha1 = coalesce(blobs.b64sha1, excluded.b64sha1)`,
  [hash, b64sha1, mime, meta.width, meta.height, buf.length]).catch(() => {});
  return { hash, mime, width: meta.width, height: meta.height, bytes: buf.length, reused };
}

// Fast path for re-runs: the export's base64 text for an image is the same every time, so its hash finds an
// image already stored without decoding it or running it through sharp again.
async function knownImage(b64sha1) {
  const b = await one('select hash, mime, width, height, bytes from blobs where b64sha1 = $1', [b64sha1]);
  if (!b || !(await storage.has(thumbKey(b.hash)))) return null;
  return { hash: b.hash, mime: b.mime, width: b.width, height: b.height, bytes: b.bytes, reused: true, fast: true };
}

// A small pool: up to POOL images decode at once while the download keeps streaming; the reader waits when the
// pool is full, so memory stays at a few images however big the doc is.
const POOL = 4;
function pool(size) {
  const running = new Set();
  return {
    async add(task) {
      while (running.size >= size) await Promise.race(running);
      const p = task().finally(() => running.delete(p));
      running.add(p);
    },
    drain: () => Promise.all(running),
  };
}

// Images linked from the web are fetched by the server, so only public https hosts are allowed:
// a doc must not be able to point the server at itself or at a private network.
async function assertPublicHost(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('is not https');
  const addrs = await dns.lookup(u.hostname, { all: true });
  const privateIp = a => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)
    || a === '::1' || /^f[cd]/i.test(a) || /^fe80/i.test(a) || a.startsWith('::ffff:127.') || a === '::';
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('points at a private address');
}

async function fetchExternalImage(url) {
  await assertPublicHost(url);
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0];
  if (!mime.startsWith('image/')) throw new Error(`is ${mime || 'not an image'}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1048576) throw new Error('is over 15 MB');
  return saveImage(buf, mime);
}

async function downloadAndExtract(docId, rec) {
  for (let attempt = 1; ; attempt++) {
    const parser = new DocParser();
    const images = new Map(); // ref key -> saved image info
    const failedImages = new Map();
    const work = pool(POOL);
    let structureDone = false, extractStarted = false, newBytes = 0, reusedCount = 0, fastCount = 0;
    const t0 = Date.now();
    const finishStructure = () => {
      if (structureDone) return;
      structureDone = true;
      parser.endBody();
      const s = parser.stats;
      rec.done('structure', `Found ${plural(s.sections, 'section')}, ${plural(s.entries, 'numbered entry', 'numbered entries')}, ${plural(s.imageRefs, 'image reference')}`, s);
    };
    const bytesProgress = throttle(b => rec.progress('download', `Received ${mb(b)}`, { bytes: b }), 750);
    const extractProgress = throttle(() => rec.progress('extract', `Saved ${images.size} of ${parser.refs.size} images`, { saved: images.size, total: parser.refs.size }), 750);

    rec.start('download', attempt === 1 ? 'Asking Google for the Markdown export' : `Attempt ${attempt}`);
    let title = null;
    let first = true;
    // Google can take ~40 s to build a big export before the first byte; say so instead of looking stuck.
    const waiting = setInterval(() => { if (first) rec.progress('download', `Google is preparing the export (${secs(Date.now() - t0)} so far)`); }, 5000);
    try {
      const { bytes } = await streamExport(docId, {
        onTitle: t => { title = t; },
        onBytes: bytesProgress,
        onLine: async line => {
          if (first) { first = false; rec.start('structure', 'Reading headings, numbered lists and image references'); }
          if (!parser.inDefinitions) {
            if (!parser.bodyLine(line)) return;
            finishStructure();
          }
          const def = parser.definitionLine(line);
          if (!def) return;
          if (!extractStarted) { extractStarted = true; rec.start('extract', `Decoding ${plural(parser.refs.size, 'image')}, ${POOL} at a time`); }
          await work.add(async () => {
            try {
              const b64sha1 = crypto.createHash('sha1').update(def.base64).digest('hex');
              const img = (await knownImage(b64sha1)) ?? await saveImage(Buffer.from(def.base64, 'base64'), def.mime, b64sha1);
              images.set(def.key, img);
              if (img.fast) fastCount++;
              if (img.reused) reusedCount++; else newBytes += img.bytes;
            } catch (err) {
              failedImages.set(def.key, err.message);
            }
            extractProgress();
          });
        },
      });
      await work.drain();
      finishStructure();

      const missing = [...parser.refs.keys()].filter(k => !k.startsWith('http') && !images.has(k) && !failedImages.has(k));
      // Every image definition ends with ">", so a cut-off download leaves the last one open.
      if (!parser.lastDefinitionClosed) {
        throw new TruncatedError(`Download ended early: ${plural(missing.length, 'image')} never arrived`);
      }
      rec.done('download', `Downloaded ${mb(bytes)} in ${secs(Date.now() - t0)}`, { bytes, attempt, title });

      // Images linked from the web instead of embedded in the doc.
      const external = [...parser.refs.keys()].filter(k => k.startsWith('http'));
      if (!extractStarted && (external.length || parser.refs.size)) rec.start('extract', `Fetching ${plural(external.length, 'linked image')}`);
      for (const url of external) {
        try { images.set(url, await fetchExternalImage(url)); }
        catch (err) { failedImages.set(url, `Linked image ${err.message}`); }
      }
      if (parser.refs.size === 0) {
        rec.start('extract');
        rec.warn('extract', 'This doc has no images, so there is nothing to extract');
      } else {
        rec.done('extract', `Saved ${plural(images.size, 'image')}: ${images.size - reusedCount} new (${mb(newBytes)}), ${reusedCount} already stored${fastCount ? ` (${fastCount} recognised without decoding)` : ''}${failedImages.size ? `, ${failedImages.size} unreadable` : ''}`, { saved: images.size, reused: reusedCount, recognisedWithoutDecoding: fastCount, failed: failedImages.size, storage: storage.name });
      }
      return { parser, images, failedImages, missing, title };
    } catch (err) {
      const giveUp = err instanceof DocNotPublicError || err instanceof TooLargeError || attempt > RETRY_WAIT_MS.length;
      // Steps that were mid-way when the download broke stop here too, so the diagram never shows them hanging.
      if (!first && !structureDone) rec[giveUp ? 'fail' : 'retry']('structure', 'Interrupted by the download');
      if (extractStarted) rec[giveUp ? 'fail' : 'retry']('extract', `Interrupted after ${images.size} images; they stay saved and are reused`);
      if (err instanceof DocNotPublicError) {
        rec.fail('download', 'Google would not hand over this doc: either it is not shared or the link is wrong. Open it, click Share, set General access to "Anyone with the link" (Viewer), then press Try again. Your link is saved.', { reason: err.message });
        throw err;
      }
      if (err instanceof TooLargeError) {
        rec.fail('download', err.message);
        throw err;
      }
      if (giveUp) {
        rec.fail('download', `Gave up after ${attempt} attempts: ${err.message}. Your link is saved; press Try again later.`);
        throw err;
      }
      const wait = RETRY_WAIT_MS[attempt - 1];
      rec.retry('download', `Attempt ${attempt} failed (${err.message}). Images already saved are kept. Retrying in ${secs(wait)}`);
      await new Promise(r => setTimeout(r, wait));
    } finally {
      clearInterval(waiting);
    }
  }
}

function groupAndCheck(parser, images, failedImages, rec, preset) {
  const shot = preset === 'warframe' ? 'screenshot' : 'image';
  rec.start('group', 'Matching every image to its section and entry in document order');
  const sections = parser.sections.filter(s => s.entries.length || s.notes.length);
  let imageCount = 0, multi = 0;
  for (const s of sections) {
    for (const e of s.entries) {
      e.images = e.refs.map((key, ord) => ({ key, ord, ...(images.get(key) ?? {}) }));
      imageCount += e.images.length;
      if (e.images.length > 1) multi++;
    }
  }
  rec.done('group', `Grouped ${plural(imageCount, 'image')} into ${plural(sections.reduce((n, s) => n + s.entries.length, 0), 'entry', 'entries')}; ${multi} entries have several images that stay together`, {
    sections: sections.map(s => ({ title: s.title, entries: s.entries.length, images: s.entries.reduce((n, e) => n + e.images.length, 0) })),
  });

  rec.start('check', 'Looking for empty entries, duplicates and unreadable images');
  const seen = new Map();
  const counts = { empty: 0, duplicate: 0, missing: 0, small: 0 };
  const examples = [];
  for (const s of sections) {
    for (const e of s.entries) {
      e.flags = [];
      const label = `${s.title} #${e.number ?? '?'}`;
      if (e.kind === 'item' && e.images.length === 0) { e.flags.push(`No ${shot}`); counts.empty++; examples.push(`${label}: no ${shot}`); }
      for (const img of e.images) {
        img.flags = [];
        if (!img.hash) {
          img.flags.push(failedImages.get(img.key) ?? 'Image missing from the export');
          counts.missing++;
          examples.push(`${label}: image missing`);
          continue;
        }
        if (seen.has(img.hash)) { img.flags.push(`Same image as ${seen.get(img.hash)}`); counts.duplicate++; examples.push(`${label}: duplicate of ${seen.get(img.hash)}`); }
        else seen.set(img.hash, label);
        if (img.width < SMALL_PX) { img.flags.push(`Only ${img.width}px wide`); counts.small++; }
      }
      if (e.images.some(i => i.flags.length)) e.flags.push('Image needs a look');
    }
  }
  const total = counts.empty + counts.duplicate + counts.missing + counts.small;
  const summary = total
    ? [counts.empty && plural(counts.empty, `entry without a ${shot}`, `entries without a ${shot}`), counts.duplicate && plural(counts.duplicate, 'duplicate image'), counts.missing && plural(counts.missing, 'missing image'), counts.small && plural(counts.small, 'tiny image')].filter(Boolean).join(', ')
    : 'Nothing to flag';
  (total ? rec.warn : rec.done)('check', summary, { counts, examples: examples.slice(0, 12) });
  return sections;
}

async function save(runId, sections, rec) {
  rec.start('save', 'Writing sections, entries and images to the database');
  let entryIdx = 0, imageRows = 0;
  for (const [idx, s] of sections.entries()) {
    const sec = await one('insert into sections (run_id, idx, title, notes) values ($1,$2,$3,$4) returning id', [runId, idx, s.title, JSON.stringify(s.notes)]);
    if (!s.entries.length) continue;
    const rows = s.entries.map(e => ({ idx: entryIdx++, number: e.number, kind: e.kind, text: e.text, notes: e.notes, flags: e.flags }));
    const ids = await q(
      `insert into entries (run_id, section_id, idx, number, kind, text, notes, flags)
       select $1, $2, x.idx, x.number, x.kind, x.text, x.notes, x.flags
       from jsonb_to_recordset($3::jsonb) as x(idx int, number text, kind text, text text, notes jsonb, flags jsonb)
       returning id, idx`, [runId, sec.id, JSON.stringify(rows)]);
    const idByIdx = new Map(ids.map(r => [r.idx, r.id]));
    const imgs = s.entries.flatMap((e, k) => e.images.map(i => ({
      entry_id: idByIdx.get(rows[k].idx), ord: i.ord, ref_key: i.key.slice(0, 500), hash: i.hash ?? null, mime: i.mime ?? null,
      width: i.width ?? null, height: i.height ?? null, bytes: i.bytes ?? null, flags: i.flags ?? [],
    })));
    if (imgs.length) {
      await q(
        `insert into images (run_id, entry_id, ord, ref_key, hash, mime, width, height, bytes, flags)
         select $1, x.entry_id, x.ord, x.ref_key, x.hash, x.mime, x.width, x.height, x.bytes, x.flags
         from jsonb_to_recordset($2::jsonb) as x(entry_id int, ord int, ref_key text, hash text, mime text, width int, height int, bytes int, flags jsonb)`,
        [runId, JSON.stringify(imgs)]);
      imageRows += imgs.length;
    }
    s.entries.forEach((e, k) => { e.id = idByIdx.get(rows[k].idx); });
  }
  rec.done('save', `Saved ${plural(sections.length, 'section')}, ${plural(entryIdx, 'entry', 'entries')} and ${plural(imageRows, 'image')}`);
}

async function readMaps(sections, rec) {
  rec.start('maps', 'Loading the arbitration node list');
  let nodes;
  try {
    const loaded = await loadArbitrationNodes();
    nodes = loaded.nodes;
    rec.progress('maps', `Loaded ${nodes.length} arbitration nodes (${loaded.from}${loaded.note ? `: ${loaded.note}` : ''})`, { nodes: nodes.length, from: loaded.from });
  } catch (err) {
    rec.warn('maps', `Skipped: arbitration data unavailable (${err.message}). Pick map names by hand; everything else is saved.`);
    return;
  }
  const targets = sections.flatMap(s => s.entries).filter(e => e.kind === 'item' && e.images.some(i => i.hash));
  // The OCR workers start only if some screenshot has not been read before.
  let readerPromise = null;
  const reader = () => (readerPromise ??= createMapReader(nodes, 2));
  let doneCount = 0, confident = 0, failed = 0, cachedReads = 0;
  const progress = throttle(() => rec.progress('maps', `Read ${doneCount} of ${targets.length} end screens`, { done: doneCount, total: targets.length }), 750);
  try {
    await Promise.all(targets.map(async e => {
      try {
        // A run's node line can be on any of its screenshots (rewards screen vs stats screen), so read them all
        // and keep the clearest match, stopping early once one is confident.
        let guess = null;
        for (const img of e.images.filter(i => i.hash)) {
          // Each screenshot is read once ever; re-runs take the stored reading.
          const cached = await one('select ocr from blobs where hash = $1', [img.hash]);
          let g = cached?.ocr?.v === OCR_VERSION ? cached.ocr : null;
          if (g) cachedReads++;
          else {
            g = { v: OCR_VERSION, ...(await (await reader()).read(await storage.get(originalKey(img.hash, img.mime)))) };
            await q('update blobs set ocr = $2 where hash = $1', [img.hash, JSON.stringify(g)]);
          }
          if (!guess || (g.confident && !guess.confident) || (g.confident === guess.confident && g.score > guess.score)) guess = g;
          if (guess.confident) break;
        }
        if (guess.confident) confident++;
        await q('update entries set map_guess = $1, map_label = coalesce(map_label, $2) where id = $3', [JSON.stringify(guess), guess.confident ? guess.label : null, e.id]);
      } catch {
        failed++;
      }
      doneCount++;
      progress();
    }));
  } finally {
    if (readerPromise) await (await readerPromise).close();
  }
  const unsure = targets.length - confident;
  rec[unsure ? 'warn' : 'done']('maps', `Suggested a map for ${confident} of ${targets.length} runs; ${unsure} need a look${cachedReads ? `; ${cachedReads} screenshots already read in an earlier job` : ''}${failed ? ` (${failed} could not be read)` : ''}`, { confident, total: targets.length, failed, cachedReads });
}

export async function startRun({ link, owner, preset = 'plain', readMapNames = true }) {
  const docId = parseDocId(link);
  const run = await one('insert into runs (doc_id, link, preset, owner) values ($1,$2,$3,$4) returning id', [docId ?? '', String(link ?? '').slice(0, 2000), preset, owner]);
  const rec = createRecorder(run.id);
  const t0 = Date.now();
  // Keep going in the background; the page follows along over the event stream.
  (async () => {
    let status = 'done', error = null, stats = {};
    try {
      rec.start('link', 'Checking the link');
      if (!docId) {
        rec.fail('link', 'That is not a Google Docs link. Paste the address of the doc (it contains /document/d/...).');
        throw new Error('Not a Google Docs link');
      }
      rec.done('link', `Doc ID ${docId.slice(0, 6)}…${docId.slice(-4)}`);
      const { parser, images, failedImages, title } = await downloadAndExtract(docId, rec);
      if (title) await q('update runs set title = $1 where id = $2', [title, run.id]);
      const sections = groupAndCheck(parser, images, failedImages, rec, preset);
      await save(run.id, sections, rec);
      if (preset === 'warframe' && readMapNames) await readMaps(sections, rec);
      else {
        rec.start('maps');
        rec.done('maps', preset === 'warframe' ? 'Turned off for this job' : 'Not needed: this step only runs for Warframe arbitration logs');
      }
      const entries = sections.flatMap(s => s.entries);
      stats = { sections: sections.length, entries: entries.length, images: entries.reduce((n, e) => n + e.images.length, 0), flagged: entries.filter(e => e.flags.length).length };
    } catch (err) {
      status = 'failed';
      error = err.message;
    }
    await rec.flush();
    await q('update runs set status = $1, error = $2, stats = $3, finished_at = now() where id = $4', [status, error, JSON.stringify({ ...stats, ms: Date.now() - t0 }), run.id]);
    broadcast(run.id, { type: 'finished', status, error });
  })();
  return run.id;
}

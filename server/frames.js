// Warframe portraits for section headings ("Saryn", "CYTE"...), cropped to the face and shown as round icons.
// Names and image files come from WFCD's public warframe-items data; Prime variants win when a frame has one.
import sharp from 'sharp';
import { one, q } from './db.js';
import { storage } from './storage.js';

const LIST = 'https://api.warframestat.us/warframes/?language=en&only=name,imageName,isPrime';
const IMG = name => `https://cdn.warframestat.us/img/${encodeURIComponent(name)}`;
const WEEK = 7 * 24 * 3600 * 1000;
const ICON_PX = 192;

const base = name => name.replace(/\s+Prime$/i, '').replace(/-\d+$/, '').toLowerCase().replace(/[^a-z]/g, '');

let memo = null;
export async function loadFrames() {
  if (memo && Date.now() - memo.at < WEEK) return memo.frames;
  const cached = await one("select data, fetched_at from cache where key = 'warframes'");
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < WEEK) {
    memo = { frames: cached.data, at: Date.now() };
    return memo.frames;
  }
  try {
    const res = await fetch(LIST, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`warframestat answered ${res.status}`);
    // One entry per frame: its Prime portrait when there is one, otherwise the base portrait.
    const byBase = new Map();
    for (const w of await res.json()) {
      if (!w.imageName || /umbra/i.test(w.name)) continue;
      const key = base(w.name);
      const have = byBase.get(key);
      if (!have || (w.isPrime && !have.prime)) byBase.set(key, { key, name: w.name, image: w.imageName, prime: !!w.isPrime });
    }
    const frames = [...byBase.values()];
    await q("insert into cache (key, data, fetched_at) values ('warframes', $1, now()) on conflict (key) do update set data = excluded.data, fetched_at = now()", [JSON.stringify(frames)]);
    memo = { frames, at: Date.now() };
    return frames;
  } catch (err) {
    if (cached) return cached.data;
    throw err;
  }
}

// "CYTE" -> Cyte-09, "Saryn" -> Saryn Prime. Only a whole-word match counts, so "Notes" never becomes Nova.
export function matchFrame(title, frames) {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(w => w.replace(/\d+$/, ''));
  return frames.find(f => words.includes(f.key)) ?? null;
}

// The portraits are transparent PNGs with the head somewhere near the top. Find the top of the figure from the
// alpha channel, centre on the opaque pixels in that band, and crop a square that holds the head and shoulders.
async function cropFace(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const opaque = (x, y) => data[(y * w + x) * 4 + 3] > 40;
  let top = 0;
  for (; top < h; top++) {
    let count = 0;
    for (let x = 0; x < w; x++) if (opaque(x, top)) count++;
    if (count > w * 0.02) break;
  }
  const size = Math.round(Math.min(w, h) * 0.46);
  const band = Math.min(h, top + Math.round(size * 0.8));
  let sum = 0, n = 0;
  for (let y = top; y < band; y++) for (let x = 0; x < w; x++) if (opaque(x, y)) { sum += x; n++; }
  const cx = n ? sum / n : w / 2;
  const left = Math.max(0, Math.min(w - size, Math.round(cx - size / 2)));
  const y0 = Math.max(0, Math.min(h - size, top - Math.round(size * 0.06)));
  return sharp(png).extract({ left, top: y0, width: size, height: size }).resize(ICON_PX, ICON_PX).webp({ quality: 82 }).toBuffer();
}

export async function frameIcon(image) {
  const frames = await loadFrames();
  if (!frames.some(f => f.image === image)) return null; // only names from the list, never arbitrary URLs
  const key = `frames/${image.replace(/\.\w+$/, '')}.webp`;
  if (await storage.has(key)) return storage.get(key);
  const res = await fetch(IMG(image), { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`portrait answered ${res.status}`);
  const icon = await cropFace(Buffer.from(await res.arrayBuffer()));
  await storage.put(key, icon);
  return icon;
}

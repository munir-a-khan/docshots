// Optional: post one message (text + up to 10 images) through the user's own Discord webhook.
// The webhook URL comes with each request and is never saved.
import { one } from './db.js';
import { storage, originalKey } from './storage.js';

const WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+(\?thread_id=\d+)?$/;
const MAX_FILES = 10;

export async function postToWebhook({ url, content, hashes }) {
  if (!WEBHOOK.test(url ?? '')) throw new Error('That is not a Discord webhook URL (Server Settings → Integrations → Webhooks).');
  if (!Array.isArray(hashes) || hashes.length > MAX_FILES) throw new Error(`Discord allows at most ${MAX_FILES} images per message.`);

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: String(content ?? '').slice(0, 2000), allowed_mentions: { parse: [] } }));
  for (const [i, hash] of hashes.entries()) {
    const img = await one('select mime from images where hash = $1 limit 1', [hash]);
    if (!img) throw new Error('One of the images no longer exists.');
    const buf = await storage.get(originalKey(hash, img.mime));
    form.append(`files[${i}]`, new Blob([buf], { type: img.mime }), `${i + 1}.${img.mime.split('/')[1]}`);
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    if (res.ok || res.status === 204) return { ok: true, attempts: attempt };
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const wait = Math.ceil((body.retry_after ?? 1) * 1000);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error('Discord kept rate-limiting; wait a minute and send again.');
}

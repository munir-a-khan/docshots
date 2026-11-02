// Image files are stored by content hash, so a re-run of the same doc reuses what is already saved.
// Replit Object Storage when a bucket is attached (deployments have no persistent disk), local disk otherwise.
import fs from 'node:fs';
import path from 'node:path';

let backend;

export async function initStorage() {
  if (process.env.REPLIT_DEFAULT_BUCKET_ID || process.env.STORAGE === 'replit') {
    const { Client } = await import('@replit/object-storage');
    const c = new Client();
    backend = {
      name: 'Replit Object Storage',
      async has(key) { const r = await c.exists(key); return r.ok && r.value; },
      async put(key, buf) { const r = await c.uploadFromBytes(key, buf); if (!r.ok) throw new Error(r.error.message); },
      async get(key) { const r = await c.downloadAsBytes(key); if (!r.ok) throw new Error(r.error.message); return r.value[0]; },
      async remove(key) { await c.delete(key, { ignoreNotFound: true }); },
    };
  } else {
    const root = path.resolve('data/blobs');
    fs.mkdirSync(root, { recursive: true });
    const file = key => path.join(root, key.replace(/[^\w.-]/g, '_'));
    backend = {
      name: 'local disk',
      async has(key) { return fs.existsSync(file(key)); },
      async put(key, buf) { await fs.promises.writeFile(file(key), buf); },
      async get(key) { return fs.promises.readFile(file(key)); },
      async remove(key) { await fs.promises.rm(file(key), { force: true }); },
    };
  }
}

export const storage = {
  get name() { return backend.name; },
  has: key => backend.has(key),
  put: (key, buf) => backend.put(key, buf),
  get: key => backend.get(key),
  remove: key => backend.remove(key),
};

export const originalKey = (hash, mime) => `orig/${hash}.${(mime || 'image/png').split('/')[1]}`;
export const thumbKey = hash => `thumb/${hash}.webp`;

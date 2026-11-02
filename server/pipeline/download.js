// Streams a Google Doc's Markdown export and hands it out line by line, so memory stays at one line
// (the largest line is a single base64 image, ~1 MB) no matter how big the doc is.

export class DocNotPublicError extends Error {}
export class TruncatedError extends Error {}
export class TooLargeError extends Error {}

// Big enough for a 300-screenshot log (the test doc is ~139 MB); stops runaway or hostile docs.
export const MAX_BYTES = Number(process.env.MAX_DOC_MB || 400) * 1048576;

export function parseDocId(link) {
  const m = /docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})/.exec(link ?? '');
  return m?.[1] ?? null;
}

const STALL_MS = 60_000;
const TOTAL_MS = 5 * 60_000;

function titleFrom(disposition) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '');
  const plain = /filename="([^"]+)"/i.exec(disposition ?? '');
  const name = star ? decodeURIComponent(star[1]) : plain?.[1];
  return name?.replace(/\.md$/i, '') ?? null;
}

export async function streamExport(docId, { onLine, onBytes, onTitle }) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=md`;
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(new Error('Download took longer than 5 minutes')), TOTAL_MS);
  let stall;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => ctrl.abort(new Error('Google stopped sending data for 60 s')), STALL_MS);
  };

  try {
    armStall();
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') ?? '';
    // A private doc redirects to a Google sign-in page instead of the export.
    if (res.status === 401 || res.status === 403 || res.status === 404 || /accounts\.google\.com/.test(res.url) || type.includes('text/html')) {
      res.body?.cancel().catch(() => {});
      throw new DocNotPublicError(`Google answered ${res.status} with ${type.split(';')[0] || 'no content type'}`);
    }
    if (!res.ok) throw new Error(`Google answered ${res.status} ${res.statusText}`);
    onTitle?.(titleFrom(res.headers.get('content-disposition')));

    let bytes = 0;
    let parts = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      bytes += value.length;
      if (bytes > MAX_BYTES) {
        reader.cancel().catch(() => {});
        throw new TooLargeError(`The doc is over ${Math.round(MAX_BYTES / 1048576)} MB. Split it into smaller docs and run each one.`);
      }
      onBytes?.(bytes);
      let start = 0;
      for (let i = value.indexOf(10); i !== -1; i = value.indexOf(10, start)) {
        parts.push(value.subarray(start, i));
        const line = parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts);
        parts = [];
        start = i + 1;
        await onLine(line.toString('utf8'));
      }
      if (start < value.length) parts.push(value.slice(start));
    }
    if (parts.length) await onLine(Buffer.concat(parts).toString('utf8'));
    return { bytes };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}

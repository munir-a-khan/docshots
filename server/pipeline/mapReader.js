// Suggests which arbitration node a mission-complete screenshot is from.
// The end screen prints "NODE (PLANET) - FACTION - MISSION TYPE" in red along the bottom; we crop that strip,
// keep only red pixels, OCR it, then align the noisy text against the closed list of arbitration nodes.
import fs from 'node:fs';
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';

const OCR_CACHE = 'data/tesseract';

// Where to look: the bottom of the screen, middle part (the node line is centred; stats and buttons sit at the sides).
const SEARCH = { x0: 0.25, x1: 0.75, y0: 0.82, y1: 1 };
const isRed = (r, g, b) => r > 70 && r > g * 1.5 && r > b * 1.5;

// Finds the node line by looking for the band of rows with the most red pixels, since its height on screen
// shifts with resolution, UI scale and whether the screenshot is a photo or a VOD frame.
async function redStrip(buf) {
  const meta = await sharp(buf).metadata();
  const top = Math.round(meta.height * SEARCH.y0);
  const area = { left: Math.round(meta.width * SEARCH.x0), top, width: Math.round(meta.width * (SEARCH.x1 - SEARCH.x0)), height: meta.height - top };
  const { data, info } = await sharp(buf).extract(area).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = new Array(info.height).fill(0);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      if (isRed(data[i], data[i + 1], data[i + 2])) rows[y]++;
    }
  }
  const band = Math.max(4, Math.round(meta.height * 0.022));
  let bestY = 0, bestSum = -1;
  for (let y = 0; y + band <= rows.length; y++) {
    let s = 0;
    for (let k = 0; k < band; k++) s += rows[y + k];
    if (s > bestSum) { bestSum = s; bestY = y; }
  }
  const pad = Math.ceil(band * 0.4);
  const y0 = Math.max(0, bestY - pad), y1 = Math.min(info.height, bestY + band + pad);
  const w = Math.round(meta.width * 0.6), left = Math.round((meta.width - w) / 2);
  const line = await sharp(buf).extract({ left, top: top + y0, width: w, height: y1 - y0 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(line.info.width * line.info.height);
  for (let i = 0, p = 0; i < line.data.length; i += 3, p++) {
    // Dark text on white, shaded by how strongly red the pixel is, which keeps letter edges for the OCR.
    const r = line.data[i], g = line.data[i + 1], b = line.data[i + 2];
    const redness = r - Math.max(g, b);
    out[p] = redness > 25 && r > 60 ? Math.max(0, 255 - redness * 3) : 255;
  }
  const scale = Math.max(4, Math.round(48 / line.info.height));
  return sharp(out, { raw: { width: line.info.width, height: line.info.height, channels: 1 } })
    .resize({ width: line.info.width * scale, kernel: 'lanczos3' })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' })
    .png().toBuffer();
}

export { redStrip };

// Letters tesseract mixes up on this font; a substitution inside a group is a near-match.
const LOOKALIKE = ['CEGOQD0', 'RFPKB', 'SZ52', 'IL1TJ', 'MNHW', 'BE8', 'UVW', 'AR4'];
const near = (a, b) => LOOKALIKE.some(g => g.includes(a) && g.includes(b));
const letters = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Smith-Waterman local alignment, scored as the share of `pattern` the OCR text supports (0..1).
// Local alignment tolerates junk around the line and characters the OCR dropped at either end.
function support(pattern, text) {
  if (!pattern || !text) return 0;
  let prev = new Float32Array(text.length + 1);
  let best = 0;
  for (let i = 1; i <= pattern.length; i++) {
    const cur = new Float32Array(text.length + 1);
    for (let j = 1; j <= text.length; j++) {
      const a = pattern[i - 1], b = text[j - 1];
      const diag = prev[j - 1] + (a === b ? 2 : near(a, b) ? 1 : -1);
      cur[j] = Math.max(0, diag, prev[j] - 1, cur[j - 1] - 1);
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best / (2 * pattern.length);
}

export function rankNodes(ocrText, nodes) {
  const text = letters(ocrText);
  return nodes.map(n => {
    // Node name + planet carries the identity; the full line (faction, type) separates look-alike names.
    const name = support(letters(`${n.name}${n.planet}`), text);
    const full = support(letters(n.screen), text);
    return { id: n.id, label: n.label, score: 0.6 * name + 0.4 * full };
  }).sort((a, b) => b.score - a.score);
}

// Confidence needs both a good score and a clear lead over the runner-up.
export function judge(ranked) {
  const [best, second] = ranked;
  if (!best) return null;
  const margin = best.score - (second?.score ?? 0);
  const confident = best.score >= 0.55 && margin >= 0.08;
  return { label: best.label, score: +best.score.toFixed(2), margin: +margin.toFixed(2), runnerUp: second?.label ?? null, confident };
}

export async function createMapReader(nodes, poolSize = 2) {
  fs.mkdirSync(OCR_CACHE, { recursive: true });
  const workers = await Promise.all(Array.from({ length: poolSize }, async () => {
    const w = await createWorker('eng', 1, { cachePath: OCR_CACHE });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, user_defined_dpi: '300' });
    return w;
  }));
  const idle = [...workers];
  const waiting = [];
  const take = () => idle.length ? Promise.resolve(idle.pop()) : new Promise(r => waiting.push(r));
  const give = w => (waiting.length ? waiting.shift()(w) : idle.push(w));

  return {
    async read(buf) {
      const strip = await redStrip(buf);
      const w = await take();
      try {
        const { data } = await w.recognize(strip);
        const text = data.text.trim();
        return { text, ...judge(rankNodes(text, nodes)) };
      } finally {
        give(w);
      }
    },
    close: () => Promise.all(workers.map(w => w.terminate())),
  };
}

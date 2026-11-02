// Prototype: read the node line and the mode/wave subtitle from mission-complete screenshots.
import sharp from 'sharp';
import { createWorker, PSM } from 'tesseract.js';

const files = process.argv.slice(2);
const worker = await createWorker('eng');
await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });

// Warframe's end-screen text is red; keep pixels where red clearly dominates.
async function redLine(file, box) {
  const meta = await sharp(file).metadata();
  const r = {
    left: Math.round(meta.width * box.x0), top: Math.round(meta.height * box.y0),
    width: Math.round(meta.width * (box.x1 - box.x0)), height: Math.round(meta.height * (box.y1 - box.y0)),
  };
  const { data, info } = await sharp(file).extract(r).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
    out[p] = R > 90 && R > G * 1.6 && R > B * 1.6 ? 0 : 255;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width: info.width * 4, kernel: 'lanczos3' }).png().toBuffer();
}

for (const f of files) {
  const node = await worker.recognize(await redLine(f, { x0: 0.2, x1: 0.8, y0: 0.90, y1: 0.975 }));
  const sub = await worker.recognize(await redLine(f, { x0: 0.35, x1: 0.65, y0: 0.025, y1: 0.065 }));
  console.log(f.split('/').pop(), '| node:', node.data.text.trim(), `(${node.data.confidence})`, '| sub:', sub.data.text.trim(), `(${sub.data.confidence})`);
}
await worker.terminate();

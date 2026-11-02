// Prototype: match noisy OCR of the end-screen node line against the closed list of arbitration nodes.
import fs from 'fs';
const sol = JSON.parse(fs.readFileSync(new URL('./solNodes.json', import.meta.url)));
const ids = new Set(fs.readFileSync(new URL('./arbys.txt', import.meta.url), 'utf8').trim().split('\n').map(l => l.split(',')[1]));
const faction = { Infested: 'INFESTATION', Grineer: 'GRINEER', Corpus: 'CORPUS', Orokin: 'OROKIN', Corrupted: 'CORRUPTED', Murmur: 'MURMUR' };
const nodes = [...ids].map(id => {
  const n = sol[id]; const [name, planet] = n.value.toUpperCase().split(' (');
  return { id, label: n.value, name, planet: planet.replace(')', ''), enemy: faction[n.enemy] ?? n.enemy.toUpperCase(), type: n.type.toUpperCase() };
});
const norm = s => s.toUpperCase().replace(/[^A-Z]/g, '');
const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 2; i++) { const k = s.slice(i, i + 3); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
// Share of the candidate's trigrams found in the OCR text (OCR adds noise, so measure containment, not equality).
const contain = (part, text) => { const a = grams(norm(part)), b = grams(text); let hit = 0, tot = 0; for (const [k, c] of a) { tot += c; hit += Math.min(c, b.get(k) ?? 0); } return tot ? hit / tot : 0; };
// OCR on thin red text confuses these shapes; substituting within a group costs less than a full edit.
const like = ['CEGO0Q', 'RFPK', 'SZ52', 'IL1T|', 'MNH', 'BE8', 'UVW', 'AR'];
const sub = (a, b) => a === b ? 0 : like.some(g => g.includes(a) && g.includes(b)) ? 0.4 : 1;
// Sellers' approximate substring match: cheapest edit distance of `pat` against any slice of `text`, as 0..1 similarity.
const fuzzy = (pat, text) => {
  pat = norm(pat); if (!pat) return 0;
  let prev = new Array(text.length + 1).fill(0);
  for (let i = 1; i <= pat.length; i++) {
    const cur = [i];
    for (let j = 1; j <= text.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub(pat[i - 1], text[j - 1]));
    prev = cur;
  }
  return Math.max(0, 1 - Math.min(...prev) / pat.length);
};
export function matchNode(ocr) {
  const t = norm(ocr);
  return nodes.map(n => ({ n, score: 0.45 * fuzzy(n.name, t) + 0.2 * fuzzy(n.planet, t) + 0.15 * fuzzy(n.enemy, t) + 0.2 * fuzzy(n.type.replace('DARK SECTOR ', ''), t) }))
    .sort((a, b) => b.score - a.score).slice(0, 3).map(r => `${r.n.label} ${r.n.type} ${r.score.toFixed(2)}`);
}
for (const s of process.argv.slice(2)) console.log(s, '=>', matchNode(s));

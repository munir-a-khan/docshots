// Runs the map reader over sample screenshots and prints its suggestion for each.
import fs from 'node:fs';
import { createMapReader } from '../server/pipeline/mapReader.js';
const sol = JSON.parse(fs.readFileSync('proto/solNodes.json'));
const ids = new Set(fs.readFileSync('proto/arbys.txt', 'utf8').trim().split('\n').map(l => l.split(',')[1]));
const F = { Infested: 'INFESTATION' };
const nodes = [...ids].filter(i => sol[i]).map(id => { const n = sol[id]; const [name, p = ''] = n.value.split(' (');
  return { id, label: n.value, name, planet: p.replace(')', ''), screen: `${n.type.startsWith('Dark Sector') ? 'DARK SECTOR ' : ''}${n.value} - ${F[n.enemy] ?? n.enemy} - ${n.type.replace('Dark Sector ', '')}`.toUpperCase() }; });
const reader = await createMapReader(nodes, 2);
const files = process.argv.slice(2);
const out = await Promise.all(files.map(async f => [f.split('/').pop(), await reader.read(fs.readFileSync(f))]));
for (const [f, r] of out) console.log(f.padEnd(14), r.confident ? 'OK ' : '?? ', String(r.score).padEnd(5), String(r.margin).padEnd(5), r.label.padEnd(22), '|', r.runnerUp, '|', r.text);
await reader.close();

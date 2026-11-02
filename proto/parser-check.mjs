// Feeds a saved Markdown export through the parser and reports what it found, including truncation.
import fs from 'node:fs';
import readline from 'node:readline';
import { DocParser } from '../server/pipeline/docParser.js';
const p = new DocParser();
const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2]), crlfDelay: Infinity });
for await (const line of rl) { if (!p.inDefinitions && !p.bodyLine(line)) continue; p.definitionLine(line); }
const secs = p.sections.map(s => `${s.title}:${s.entries.length}/${s.entries.reduce((n, e) => n + e.refs.length, 0)}`).join(' ');
console.log(p.stats, '| defs', p.definitionsSeen, '| last closed', p.lastDefinitionClosed, '\n', secs);
const mir = p.sections.find(s => s.title === 'Mirage');
console.log('Mirage notes', mir.notes, '| #18', mir.entries.find(e => e.number === '18'), '| Cyte #13', p.sections[0].entries.find(e => e.number === '13'));

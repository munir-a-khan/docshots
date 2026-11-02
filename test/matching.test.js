import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankNodes, judge } from '../server/pipeline/mapReader.js';
import { matchFrame } from '../server/frames.js';
import { parseDocId } from '../server/pipeline/download.js';

const nodes = [
  ['Cinxia', 'Ceres', 'GRINEER', 'INTERCEPTION'],
  ['Casta', 'Ceres', 'GRINEER', 'DEFENSE'],
  ['Seimeni', 'Ceres', 'INFESTATION', 'DEFENSE'],
  ['Io', 'Jupiter', 'CORPUS', 'DEFENSE'],
  ['Xini', 'Eris', 'INFESTATION', 'INTERCEPTION'],
].map(([name, planet, enemy, type], i) => ({ id: `n${i}`, name, planet, label: `${name} (${planet})`, screen: `${name} (${planet}) - ${enemy} - ${type}`.toUpperCase() }));

// These are real OCR outputs from the test doc's 624px screenshots.
test('noisy OCR of the node line still finds the node', () => {
  assert.equal(judge(rankNodes('CASTA (CERES) - GRINEER - DEFENEE N | .', nodes)).label, 'Casta (Ceres)');
  assert.equal(judge(rankNodes('OANK ZECTOM STINENI (CERES) - INFESTATION - CEE EE', nodes)).label, 'Seimeni (Ceres)');
});

test('a short name does not win on noise alone', () => {
  const verdict = judge(rankNodes('a re GH .', nodes));
  assert.equal(verdict.confident, false);
});

test('section headings match frames by whole word, Prime preferred upstream', () => {
  const frames = [{ key: 'cyte', name: 'Cyte-09' }, { key: 'saryn', name: 'Saryn Prime' }, { key: 'nova', name: 'Nova Prime' }];
  assert.equal(matchFrame('CYTE', frames).name, 'Cyte-09');
  assert.equal(matchFrame('Saryn', frames).name, 'Saryn Prime');
  assert.equal(matchFrame('Novas and notes', frames), null);
});

test('doc IDs come out of every common link form', () => {
  const id = '1N9fnfrXmtExkfVlAhQ5kB4Z6jnZoCisFHquqYcMxedk';
  for (const link of [
    `https://docs.google.com/document/d/${id}/edit?tab=t.0#heading=h.f99`,
    `https://docs.google.com/document/u/1/d/${id}/view`,
    `docs.google.com/document/d/${id}`,
  ]) assert.equal(parseDocId(link), id);
  assert.equal(parseDocId('https://example.com/notadoc'), null);
});

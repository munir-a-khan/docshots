import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocParser } from '../server/pipeline/docParser.js';

// Feeds a Markdown export through the parser the way the download does: body lines, then definitions.
function parse(md) {
  const p = new DocParser();
  const defs = [];
  for (const line of md.split('\n')) {
    if (!p.inDefinitions && !p.bodyLine(line)) continue;
    const d = p.definitionLine(line);
    if (d) defs.push(d);
  }
  return { p, defs };
}

const PNG = 'iVBORw0KGgo=';

test('headings become sections and numbered lines become entries, numbers as written', () => {
  const { p } = parse(['# CYTE', '', '1. s  ', '2. ![][image1]  ', '', '29. ![][image2]', '# Saryn', '1. ![][image3]'].join('\n'));
  assert.deepEqual(p.sections.map(s => s.title), ['CYTE', 'Saryn']);
  assert.deepEqual(p.sections[0].entries.map(e => e.number), ['1', '2', '29']);
  assert.deepEqual(p.sections[0].entries[1].refs, ['image1']);
  assert.equal(p.sections[0].entries[0].refs.length, 0, 'an entry without an image is kept, with no refs');
});

test('indented images and nested items belong to the entry above them', () => {
  const { p } = parse(['# Mirage', '13. s![][image12]  ', '    ![][image13]  ', '18. ![][image20]', '    1. Defense on this', '    1. 20r'].join('\n'));
  const [thirteen, eighteen] = p.sections[0].entries;
  assert.deepEqual(thirteen.refs, ['image12', 'image13']);
  assert.equal(thirteen.text, 's');
  assert.deepEqual(eighteen.notes, ['Defense on this', '20r']);
});

test('several images on one line keep their order', () => {
  const { p } = parse('# A\n8. s![][image6]![][image7]![][image9]');
  assert.deepEqual(p.sections[0].entries[0].refs, ['image6', 'image7', 'image9']);
});

test('paragraphs become section notes and empty headings are skipped', () => {
  const { p } = parse(['# Mirage', '200w', '1. ![][image1]', '#', '30/30 (1 200w; 2 20 r)'].join('\n'));
  assert.equal(p.sections.length, 1);
  assert.deepEqual(p.sections[0].notes, ['200w', '30/30 (1 200w; 2 20 r)']);
});

test('images outside a list become a loose entry; escaped characters are unescaped', () => {
  const { p } = parse('# Gallery\n![][image1] caption \\= done');
  const [loose] = p.sections[0].entries;
  assert.equal(loose.kind, 'loose');
  assert.equal(loose.text, 'caption = done');
});

test('image definitions are read after the body, and a closed export is complete', () => {
  const { p, defs } = parse(`# A\n1. ![][image1]\n\n[image1]: <data:image/png;base64,${PNG}>`);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].key, 'image1');
  assert.equal(defs[0].base64, PNG);
  assert.equal(p.lastDefinitionClosed, true);
});

test('a download cut off inside an image is detected', () => {
  const { p } = parse(`# A\n1. ![][image1]\n\n[image1]: <data:image/png;base64,${PNG.slice(0, 6)}`);
  assert.equal(p.lastDefinitionClosed, false);
});

test('stats count sections, entries and image references', () => {
  const { p } = parse('# A\n1. ![][image1]![][image2]\n2. s\n# B\n1. ![][image3]');
  assert.deepEqual(p.stats, { sections: 2, entries: 3, looseGroups: 0, imageRefs: 3 });
});

// Reads Google Docs' Markdown export one line at a time.
// The export puts the body (headings, numbered lists, image references) first and every image as a base64
// reference definition at the end, so structure is known before the first image byte arrives.

const HEADING = /^(#{1,6})\s*(.*)$/;
// "1. ", plus the hand-typed forms the export escapes or squeezes: "1\\." and "3.![image]".
const NUMBERED = /^( *)(\d{1,4})\\?[.)](?=\s|$|!\[)\s*(.*)$/;
// A short plain line right before a list that starts at 1 is that list's heading, even without a heading style.
const PLAIN_TITLE = /^[^.!?:;,]{1,48}$/;
const BULLET = /^( *)[*+-]\s+(.*)$/;
const IMAGE_REF = /!\[[^\]]*\]\[([^\]]+)\]|!\[[^\]]*\]\((\S+?)\)/g;
const DEFINITION = /^\[([^\]]+)\]:\s*<?data:(image\/[\w+.-]+);base64,/;

const unescape = s => s.replace(/\\([\\`*_{}\[\]()#+\-.!=|>~])/g, '$1').replace(/\s+$/, '');

function splitImages(text) {
  const refs = [];
  const rest = text.replace(IMAGE_REF, (_, key, url) => { refs.push(key ?? url); return ' '; });
  return { refs, text: unescape(rest).replace(/\s+/g, ' ').trim() };
}

export class DocParser {
  constructor() {
    this.sections = [];
    this.section = null;
    this.entry = null;
    this.refs = new Map(); // ref key -> { entry, ord } for every place it is used
    this.refOrder = [];
    this.inDefinitions = false;
    this.definitionsSeen = 0;
    this.lastDefinitionClosed = true;
    this.bulletCounter = 0;
    this.pendingTitle = null;
  }

  // A plain line that turned out not to be a heading goes back to being a note.
  flushPending() {
    if (this.pendingTitle == null) return;
    this.ensureSection().notes.push(this.pendingTitle);
    this.pendingTitle = null;
  }

  startSection(title, fromHeading = false) {
    this.section = { title, notes: [], entries: [], fromHeading };
    this.sections.push(this.section);
    this.entry = null;
    this.bulletCounter = 0;
  }

  // Call once the body has ended (the first image definition, or the end of a doc with no images).
  endBody() { this.flushPending(); }

  get stats() {
    const entries = this.sections.flatMap(s => s.entries);
    return {
      sections: this.sections.length,
      entries: entries.filter(e => e.kind === 'item').length,
      looseGroups: entries.filter(e => e.kind === 'loose').length,
      imageRefs: this.refOrder.length,
    };
  }

  ensureSection(title = 'Before the first heading') {
    if (!this.section) {
      this.section = { title, notes: [], entries: [] };
      this.sections.push(this.section);
    }
    return this.section;
  }

  addEntry(kind, number, text) {
    const sec = this.ensureSection();
    const entry = { kind, number, text, notes: [], refs: [] };
    sec.entries.push(entry);
    return entry;
  }

  attach(entry, refs) {
    for (const key of refs) {
      entry.refs.push(key);
      this.refOrder.push(key);
      if (!this.refs.has(key)) this.refs.set(key, []);
      this.refs.get(key).push(entry);
    }
  }

  // Returns true once the body is over and image definitions have started.
  bodyLine(raw) {
    if (DEFINITION.test(raw)) { this.endBody(); this.inDefinitions = true; return true; }
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return false;

    let m;
    if ((m = HEADING.exec(line))) {
      const title = unescape(m[2]).replace(/\*\*/g, '').trim();
      if (!title) return false; // Docs exports empty headings as a bare "#"
      this.flushPending();
      this.startSection(title, true);
      return false;
    }

    const numbered = NUMBERED.exec(line);
    const bullet = !numbered && BULLET.exec(line);
    if (numbered || bullet) {
      const indent = (numbered ?? bullet)[1].length;
      const { refs, text } = splitImages(numbered ? numbered[3] : bullet[2]);
      // ...unless a real heading sits right above it with nothing under it yet ("# Mirage", "200w", "1."):
      // then the short line is that heading's note.
      const underFreshHeading = this.section?.fromHeading && this.section.entries.length === 0;
      if (indent === 0 && this.pendingTitle != null && (bullet || numbered[2] === '1') && !underFreshHeading) {
        this.startSection(this.pendingTitle);
        this.pendingTitle = null;
      } else if (indent === 0) {
        this.flushPending();
      }
      if (indent === 0) {
        const number = numbered ? numbered[2] : String(++this.bulletCounter);
        this.entry = this.addEntry('item', number, text);
        this.attach(this.entry, refs);
      } else {
        // A nested item is a note on the run above it (e.g. "200w", "20r"); its images still belong to that run.
        const entry = this.entry ?? (this.entry = this.addEntry('item', null, ''));
        if (text) entry.notes.push(text);
        this.attach(entry, refs);
      }
      return false;
    }

    const indented = /^ +\S/.test(line);
    const { refs, text } = splitImages(line);
    if (indented && this.entry) {
      if (text) this.entry.notes.push(text);
      this.attach(this.entry, refs);
      return false;
    }
    // Images on their own line under a numbered item belong to it (people often press Enter after "2.").
    if (refs.length && !text && this.entry) {
      this.attach(this.entry, refs);
      return false;
    }
    this.flushPending();
    if (refs.length) {
      const loose = this.addEntry('loose', null, text);
      this.attach(loose, refs);
      this.entry = null;
      return false;
    }
    this.entry = null;
    const plain = text.replace(/\*\*/g, '').trim();
    if (PLAIN_TITLE.test(plain)) this.pendingTitle = plain;
    else this.ensureSection().notes.push(text);
    return false;
  }

  // Parses one definition line; returns { key, mime, base64 } or null.
  definitionLine(raw) {
    const m = DEFINITION.exec(raw);
    if (!m) return null;
    let b64 = raw.slice(m[0].length).trimEnd();
    this.lastDefinitionClosed = b64.endsWith('>');
    if (this.lastDefinitionClosed) b64 = b64.slice(0, -1);
    this.definitionsSeen++;
    return { key: m[1], mime: m[2], base64: b64 };
  }
}

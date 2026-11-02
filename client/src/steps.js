// The eight steps of a job, in order. The same ids are what the server emits, so diagram and events always match.
export const STEPS = [
  { id: 'link', title: 'Check link', layer: 'your browser', blurb: 'Reads the doc ID out of the link. The link is saved first, so a failure never loses it.' },
  { id: 'download', title: 'Download the doc', layer: 'Google Docs', blurb: 'Streams the doc from Google and processes it as it arrives. Big docs take Google about 40 s to prepare.' },
  { id: 'structure', title: 'Read structure', layer: 'the server', blurb: 'Finds headings, numbered entries, notes and image positions while the download continues.' },
  { id: 'extract', title: 'Extract images', layer: 'the server', blurb: 'Decodes up to four images at once and stores each with a thumbnail. Images seen in an earlier job are recognised without decoding.' },
  { id: 'group', title: 'Group entries', layer: 'the server', blurb: 'Puts every image under its section and entry, in document order. An entry\'s images stay together.' },
  { id: 'check', title: 'Check', layer: 'the server', blurb: 'Flags entries without an image, duplicate images and images missing from the doc.' },
  { id: 'save', title: 'Save', layer: 'the database', blurb: 'Writes everything to Postgres, so results survive a refresh and open on any device.' },
  { id: 'maps', title: 'Suggest map names', layer: 'public game data', blurb: 'Warframe preset only: reads the map name on each mission-complete screenshot and matches it against the game\'s 88 arbitration maps.' },
];

// Folds an event list into the current state of each step.
export function stepStates(events) {
  const state = Object.fromEntries(STEPS.map(s => [s.id, { status: 'idle', detail: '', duration: null, log: [] }]));
  for (const ev of events) {
    const s = state[ev.step];
    if (!s) continue;
    s.log.push(ev);
    if (ev.status === 'start') { s.status = 'running'; s.detail = ev.detail; s.duration = null; }
    else if (ev.status === 'progress') { if (!['done', 'warn', 'fail'].includes(s.status)) s.status = 'running'; s.detail = ev.detail; }
    else { s.status = ev.status; s.detail = ev.detail; s.duration = ev.duration ?? s.duration; s.data = ev.data ?? s.data; }
  }
  return state;
}

export const fmtMs = ms => (ms == null ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

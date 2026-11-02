import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import Diagram from './Diagram.jsx';
import Results, { SectionPicker, FrameIcon } from './Results.jsx';
import Queue from './Queue.jsx';
import { fmtMs } from './steps.js';
import { wordsFor } from './words.js';

const SCREENS = { report: 'Job report', queue: 'Paste queue', review: 'Review' };

const routeFromHash = () => {
  const m = /^#\/run\/(\d+)(?:\/(\w+))?/.exec(location.hash);
  if (m) return { runId: Number(m[1]), screen: SCREENS[m[2]] ? m[2] : 'report' };
  return { runId: null, screen: location.hash === '#/history' ? 'history' : 'new' };
};
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const n = new Intl.NumberFormat();

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [runs, setRuns] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const on = () => { setRoute(routeFromHash()); setMenuOpen(false); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // The job list feeds the switcher, the breadcrumb and the history; refresh it whenever the screen changes.
  useEffect(() => { api.runs().then(setRuns).catch(() => setRuns([])); }, [route.runId, route.screen]);

  const current = runs?.find(r => r.id === route.runId);
  const screenName = route.runId ? SCREENS[route.screen] : route.screen === 'history' ? 'Past jobs' : 'New job';

  return (
    <div className={`shell ${menuOpen ? 'menu-open' : ''}`}>
      <a className="skip" href="#main">Skip to content</a>
      <aside className="side" aria-label="DocShots">
        <a href="#/" className="brand" translate="no"><Mark />DocShots</a>
        <nav aria-label="Screens">
          <a href="#/" aria-current={route.screen === 'new' ? 'page' : undefined}><Icon d="M8 3v10M3 8h10" />New job</a>
          <a href="#/history" aria-current={route.screen === 'history' ? 'page' : undefined}><Icon d="M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z" />Past jobs</a>
          {route.runId && (
            <>
              <p className="side-group">This job</p>
              <a href={`#/run/${route.runId}/report`} aria-current={route.screen === 'report' ? 'page' : undefined}><Icon d="M2.5 3.5h5v4h-5zM8.5 8.5h5v4h-5zM5 7.5v3.5h3.5" />Job report</a>
              <a href={`#/run/${route.runId}/queue`} aria-current={route.screen === 'queue' ? 'page' : undefined}><Icon d="M5 2.5h6.5v9H5zM3 5v8.5h6" />Paste queue</a>
              <a href={`#/run/${route.runId}/review`} aria-current={route.screen === 'review' ? 'page' : undefined}><Icon d="M2.5 4h11M2.5 8h11M2.5 12h7" />Review</a>
            </>
          )}
        </nav>
        <p className="side-foot">Reads public Google Docs only. Screenshots are stored once, by content.</p>
      </aside>

      <div className="main">
        <header className="top">
          <button className="menu-button quiet" aria-expanded={menuOpen} aria-label="Menu" onClick={() => setMenuOpen(o => !o)}>
            <Icon d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          </button>
          <p className="crumbs">
            {route.runId ? (<><a href="#/history">Past jobs</a><span aria-hidden="true">/</span><span className="crumb-doc">{current?.title || 'Untitled doc'}</span></>) : <span>{screenName}</span>}
          </p>
          {runs?.length > 0 && (
            <label className="switcher">
              <span className="sr-only">Open a job</span>
              <select value={route.runId ?? ''} onChange={e => { if (e.target.value) location.hash = `#/run/${e.target.value}/${route.screen in SCREENS ? route.screen : 'report'}`; }}>
                <option value="">Open a job…</option>
                {runs.filter(r => r.status !== 'failed').map(r => (
                  <option key={r.id} value={r.id}>{r.title || 'Untitled doc'}, {dateFmt.format(new Date(r.started_at))}</option>
                ))}
              </select>
            </label>
          )}
        </header>
        <main id="main" className="canvas">
          {route.runId
            ? <RunView key={route.runId} runId={route.runId} screen={route.screen} />
            : route.screen === 'history' ? <History runs={runs} /> : <NewRun runs={runs} />}
        </main>
      </div>
    </div>
  );
}

function Icon({ d }) {
  return <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d={d} /></svg>;
}

function Mark() {
  // Two stacked frames: screenshots on their way out of a doc.
  return (
    <svg className="mark" viewBox="0 0 28 22" aria-hidden="true">
      <rect x="1" y="5" width="18" height="14" rx="3" />
      <rect x="9" y="1" width="18" height="14" rx="3" />
    </svg>
  );
}

function NewRun({ runs }) {
  const [link, setLink] = useState(() => { try { return localStorage.getItem('docshots:lastLink') ?? ''; } catch { return ''; } });
  // DocShots is for any doc; the Warframe preset is remembered for people who use it.
  const [preset, setPreset] = useState(() => { try { return localStorage.getItem('docshots:preset') ?? 'plain'; } catch { return 'plain'; } });
  useEffect(() => { try { localStorage.setItem('docshots:preset', preset); } catch { /* private mode */ } }, [preset]);
  const [readMaps, setReadMaps] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState(null);
  const [preview, setPreview] = useState(null);

  useEffect(() => { api.config().then(c => setSample(c.sampleDoc)).catch(() => {}); }, []);
  // A real message from the latest finished job, as the example of what you get.
  const lastDone = runs?.find(r => r.status === 'done')?.id;
  useEffect(() => {
    if (!lastDone) return;
    api.run(lastDone).then(d => {
      const entry = d.entries.find(e => e.map_label && d.images.filter(i => i.entry_id === e.id && i.hash).length > 1)
        ?? d.entries.find(e => d.images.some(i => i.entry_id === e.id && i.hash));
      if (!entry) return;
      const section = d.sections.find(s => s.id === entry.section_id);
      setPreview({ section: section.title, frame: section.frame, w: wordsFor(d.run.preset), entry, images: d.images.filter(i => i.entry_id === entry.id && i.hash) });
    }).catch(() => {});
  }, [lastDone]);

  const start = async (url = link) => {
    setBusy(true);
    setError(null);
    try {
      try { localStorage.setItem('docshots:lastLink', url); } catch { /* private mode */ }
      const { id } = await api.startRun({ link: url, preset, readMapNames: readMaps });
      location.hash = `#/run/${id}/report`;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="new-run">
      <div className="title-row">
        <h1>New job</h1>
        <p className="subline">Images in a Google Doc can't be copied out into Discord, a forum or most other apps. Give DocShots the doc and it hands every image back in order, one paste at a time.</p>
      </div>

      <div className="new-grid">
        <form className="panel start" onSubmit={e => { e.preventDefault(); start(); }}>
          <div className="field">
            <label htmlFor="link">Google Doc link</label>
            <input id="link" name="doc-link" type="url" inputMode="url" autoComplete="off" spellCheck={false} required
              aria-describedby="link-help" placeholder="https://docs.google.com/document/d/…" value={link} onChange={e => setLink(e.target.value)} />
            <p id="link-help" className="help">Shared as “Anyone with the link can view”. A 140&nbsp;MB doc takes about a minute.</p>
          </div>
          <fieldset className="field">
            <legend>What's in it</legend>
            <label className="choice"><input type="radio" name="preset" checked={preset === 'plain'} onChange={() => setPreset('plain')} /> Any doc: headings, numbered lists and images</label>
            <label className="choice"><input type="radio" name="preset" checked={preset === 'warframe'} onChange={() => setPreset('warframe')} /> Warframe arbitration log: adds frame portraits and map names</label>
            {preset === 'warframe' && (
              <label className="choice"><input type="checkbox" checked={readMaps} onChange={e => setReadMaps(e.target.checked)} /> Read the map from each end screen</label>
            )}
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy}>{busy ? 'Starting…' : 'Extract Images'}</button>
            {sample && <button type="button" className="secondary" disabled={busy} onClick={() => { setLink(sample); start(sample); }}>Use the Sample Doc</button>}
          </div>
          <p className="help">To see how failures are handled, paste a link to a doc that isn't shared, or any link that isn't a Google Doc.</p>
        </form>

        <section className="panel example" aria-labelledby="example-title">
          <h2 id="example-title">What you paste</h2>
          {preview ? (
            <>
              <div className="chat">
                {preview.frame ? <FrameIcon frame={preview.frame} size={40} /> : <span className="chat-avatar" aria-hidden="true" />}
                <div className="chat-body">
                  <p className="chat-text">{preview.entry.number}. {preview.entry.map_label ?? ''}</p>
                  <div className="chat-images">
                    {preview.images.slice(0, 3).map(img => <img key={img.id} src={`/thumb/${img.hash}`} alt={`${preview.section} ${preview.w.item} ${preview.entry.number}`} width="320" height="180" />)}
                  </div>
                </div>
              </div>
              <p className="help">{preview.section}, {preview.w.item} {preview.entry.number} from your last doc: {preview.images.length} {preview.w.shots} that stay together in one message.</p>
              <a className="button secondary example-open" href={`#/run/${lastDone}/queue`}>Continue Pasting That Doc</a>
            </>
          ) : <p className="empty">Your first job's messages show up here: each entry's number and its images, ready to paste.</p>}
        </section>
      </div>

      {runs?.length > 0 && <History runs={runs.slice(0, 5)} compact />}
    </div>
  );
}

function History({ runs, compact }) {
  const Heading = compact ? 'h2' : 'h1';
  return (
    <section className={compact ? 'history panel' : 'history'} aria-labelledby="history-title">
      <div className={compact ? 'panel-head' : 'title-row'}>
        <Heading id="history-title">{compact ? 'Recent jobs' : 'Past jobs'}</Heading>
        {compact && runs.length > 0 && <a href="#/history">View all</a>}
      </div>
      {!runs ? <p className="empty">Loading…</p> : runs.length === 0 ? <p className="empty">No jobs yet. Paste a doc link to start one.</p> : (
        <div className={compact ? '' : 'panel'}>
          <table>
            <thead><tr><th scope="col">Doc</th><th scope="col">Result</th><th scope="col" className="num">Entries</th><th scope="col" className="num">Images</th><th scope="col" className="num">Took</th><th scope="col" className="num">Started</th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td><a href={`#/run/${r.id}/report`}>{r.title || 'Untitled doc'}</a></td>
                  <td><span className={`pill ${r.status === 'failed' ? 'negative' : r.status === 'running' ? 'neutral' : 'positive'}`}>{r.status === 'failed' ? 'Stopped' : r.status === 'running' ? 'Running' : 'Done'}</span></td>
                  <td className="num">{r.stats?.entries != null ? n.format(r.stats.entries) : <span className="dash">–</span>}</td>
                  <td className="num">{r.stats?.images != null ? n.format(r.stats.images) : <span className="dash">–</span>}</td>
                  <td className="num">{r.stats?.ms != null ? fmtMs(r.stats.ms) : <span className="dash">–</span>}</td>
                  <td className="num muted">{dateFmt.format(new Date(r.started_at))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunView({ runId, screen }) {
  const [data, setData] = useState(null);
  const [liveEvents, setLiveEvents] = useState([]);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [nodes, setNodes] = useState([]);

  const load = useCallback(() => api.run(runId).then(d => { setData(d); setError(null); }).catch(e => setError(e.message)), [runId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.nodes().then(setNodes).catch(() => {}); }, []);

  const running = data?.run.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const es = new EventSource(`/api/runs/${runId}/stream`);
    let poll;
    es.onmessage = msg => {
      const payload = JSON.parse(msg.data);
      if (payload.type === 'event') setLiveEvents(evs => [...evs, payload.event]);
      if (payload.type === 'finished') { es.close(); load(); }
    };
    // If the live stream drops, keep the screen up to date by polling instead.
    es.onerror = () => { es.close(); poll = setInterval(load, 3000); };
    return () => { es.close(); clearInterval(poll); };
  }, [running, runId, load]);

  const events = useMemo(() => {
    const stored = data?.events ?? [];
    const seen = new Set(stored.map(e => e.seq));
    return [...stored, ...liveEvents.filter(e => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
  }, [data, liveEvents]);

  // Counts follow what is on screen: computed from the rows, never stored separately.
  const facts = useMemo(() => {
    if (!data) return null;
    const kept = data.images.filter(i => !i.excluded && i.hash);
    const withShots = new Set(kept.map(i => i.entry_id));
    const runsOnly = data.entries.filter(e => e.kind === 'item');
    const counts = new Map();
    const entrySection = new Map(data.entries.map(e => [e.id, e.section_id]));
    for (const e of data.entries) { const c = counts.get(e.section_id) ?? { entries: 0, images: 0 }; c.entries++; counts.set(e.section_id, c); }
    for (const i of kept) { const c = counts.get(entrySection.get(i.entry_id)); if (c) c.images++; }
    return {
      counts,
      runs: runsOnly.length,
      shots: kept.length,
      noShot: runsOnly.filter(e => !withShots.has(e.id)).length,
      noMap: runsOnly.filter(e => withShots.has(e.id) && !e.map_label).length,
    };
  }, [data]);

  const patch = useCallback((table, id, changes) => setData(d => ({ ...d, [table]: d[table].map(r => (r.id === id ? { ...r, ...changes } : r)) })), []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="empty">Loading job…</p>;
  const { run } = data;
  const isWarframe = run.preset === 'warframe';
  const w = wordsFor(run.preset);
  const hasResults = data.sections.length > 0;

  if (screen !== 'report' && !hasResults) {
    return (
      <div className="title-row">
        <h1>{SCREENS[screen]}</h1>
        <p className="subline">{running ? 'The doc is still being read. Screenshots appear here as soon as the run saves them.' : 'This run has no screenshots to show.'} <a href={`#/run/${runId}/report`}>Open the run report</a></p>
      </div>
    );
  }

  const finding = running ? 'Reading the doc now. Each room fills in as its step finishes.'
    : run.status === 'failed' ? `Stopped: ${run.error}. The red room shows where, and what to do.`
      : `${n.format(facts.runs)} ${w.items} and ${n.format(facts.shots)} ${w.shots} in ${data.sections.length} sections, read in ${fmtMs(run.stats?.ms)}. ${
        [facts.noShot ? `${facts.noShot} ${facts.noShot === 1 ? `${w.item} has` : `${w.items} have`} no ${w.shot}` : null,
          isWarframe && facts.noMap ? `${facts.noMap} still need a map` : null].filter(Boolean).join(', and ') || 'Nothing needs a look'}.`;

  return (
    <div className="run">
      {screen === 'report' && (
        <>
          <div className="title-row with-action">
            <div>
              <h1>Job report</h1>
              <p className="subline">{finding}</p>
            </div>
            {run.status === 'failed'
              ? <button className="primary" onClick={async () => { const { id } = await api.startRun({ link: run.link, preset: run.preset }); location.hash = `#/run/${id}/report`; }}>Try Again</button>
              : hasResults && <a className="button primary" href={`#/run/${runId}/queue`}>Start Pasting</a>}
          </div>
          <Diagram events={events} live={running} />
        </>
      )}

      {screen !== 'report' && (
        <>
          <div className="title-row">
            <h1>{screen === 'review' ? `Review ${w.items}` : SCREENS[screen]}</h1>
            <p className="subline">
              {screen === 'queue'
                ? 'Copy, paste into Discord, a forum or any chat, repeat. Your place is saved on every device.'
                : isWarframe && facts.noMap ? `${facts.noMap} runs need a map and ${facts.noShot} have no screenshot. Fix them here before you paste.` : `Check each ${w.item}'s ${w.shots} before you paste.`}
            </p>
          </div>
          <SectionPicker sections={data.sections} counts={facts.counts} selected={selected} onChange={setSelected} />
          {screen === 'review'
            ? <Results data={data} selected={selected} nodes={nodes} onPatch={patch} onReload={load} isWarframe={isWarframe} w={w} />
            : <Queue runId={runId} data={data} selected={selected} w={w} />}
        </>
      )}
    </div>
  );
}

import { memo, useEffect, useState } from 'react';
import { api } from './api.js';

// Round portrait of the Warframe a section is about (Prime when there is one).
export function FrameIcon({ frame, size = 28 }) {
  if (!frame) return null;
  return <img className="frame-icon" src={frame.icon} alt="" title={frame.name} width={size} height={size} loading="lazy" />;
}

export const runName = (entry, w) => (entry.kind === 'loose' ? 'loose images' : `${w.item} ${entry.number ?? '?'}`);

// Which headings to work with; shared by the review list and the paste queue.
export function SectionPicker({ sections, counts, selected, onChange }) {
  const toggle = id => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };
  const single = selected.size === 1 ? [...selected][0] : '';
  return (
    <>
    {/* Phones get one compact menu instead of a wall of chips. */}
    <label className="sections-select">
      <span>Section</span>
      <select value={single} onChange={e => onChange(e.target.value ? new Set([Number(e.target.value)]) : new Set())}>
        <option value="">All sections</option>
        {sections.map(s => <option key={s.id} value={s.id}>{s.title} ({counts.get(s.id)?.entries ?? 0})</option>)}
      </select>
    </label>
    <fieldset className="sections">
      <legend>Sections</legend>
      <label className={`section-pill ${selected.size === 0 ? 'on' : ''}`}>
        <input type="checkbox" checked={selected.size === 0} onChange={() => onChange(new Set())} /> All
      </label>
      {sections.map(s => (
        <label key={s.id} className={`section-pill ${selected.has(s.id) ? 'on' : ''}`}>
          <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
          <FrameIcon frame={s.frame} size={26} />{s.title}<span className="num">{counts.get(s.id)?.entries ?? 0}</span>
        </label>
      ))}
    </fieldset>
    </>
  );
}

export default function Results({ data, selected, nodes, onPatch, onReload, isWarframe, w }) {
  const { sections, entries, images } = data;
  const shown = sections.filter(s => selected.size === 0 || selected.has(s.id));
  const [viewer, setViewer] = useState(null);
  // The screen's question is which runs need a look, so it opens on those.
  const [onlyLook, setOnlyLook] = useState(true);
  // A run needs a look when the doc flagged something, or (Warframe) it has screenshots but no map yet.
  const needsLook = e => e.flags?.length > 0 || (isWarframe && e.kind === 'item' && !e.map_label && images.some(i => i.entry_id === e.id && i.hash && !i.excluded));
  const lookCount = entries.filter(e => shown.some(s => s.id === e.section_id) && needsLook(e)).length;

  useEffect(() => {
    if (!viewer) return undefined;
    const onKey = e => { if (e.key === 'Escape') setViewer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer]);

  return (
    <div className="review">
      <datalist id="arbitration-nodes">{nodes.map(n => <option key={n} value={n} />)}</datalist>
      <div className="review-filter" role="group" aria-label="Show">
        <button className={onlyLook ? 'quiet' : ''} aria-pressed={!onlyLook} onClick={() => setOnlyLook(false)}>Every {w.item}</button>
        <button className={onlyLook ? '' : 'quiet'} aria-pressed={onlyLook} onClick={() => setOnlyLook(true)}>Needs a look <span className="num">{lookCount}</span></button>
      </div>
      {shown.map(section => {
        const all = entries.filter(e => e.section_id === section.id);
        const list = onlyLook ? all.filter(needsLook) : all;
        if (onlyLook && list.length === 0) return null;
        const flagged = all.filter(e => e.flags?.length).length;
        return (
          <section key={section.id} className="review-section" aria-labelledby={`sec-${section.id}`}>
            <header className={section.frame ? 'with-frame' : ''}>
              <FrameIcon frame={section.frame} size={52} />
              <h3 id={`sec-${section.id}`}>{section.title}{section.frame && section.frame.name.toLowerCase() !== section.title.toLowerCase() && <span className="frame-name">{section.frame.name}</span>}</h3>
              <p className="muted">{onlyLook ? `${list.length} of ${all.length} ${w.items} need a look` : `${all.length} ${w.items}`}{!onlyLook && flagged ? `, ${flagged} flagged` : ''}{section.notes?.length ? `. Notes in the doc: ${section.notes.join('; ')}` : ''}</p>
            </header>
            <ol className="rows">
              {list.map(entry => (
                <Row key={entry.id} section={section} entry={entry} isWarframe={isWarframe} w={w}
                  images={images.filter(i => i.entry_id === entry.id)} onPatch={onPatch} onReload={onReload} onView={setViewer} />
              ))}
            </ol>
          </section>
        );
      })}
      {viewer && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label={viewer.label}>
          <button className="viewer-close quiet" onClick={() => setViewer(null)} autoFocus>Close</button>
          <img src={`/img/${viewer.hash}`} alt={viewer.label} width={viewer.width} height={viewer.height} />
          <p>{viewer.label}, {viewer.width} × {viewer.height} px</p>
        </div>
      )}
    </div>
  );
}

const Row = memo(function Row({ section, entry, images, onPatch, onReload, onView, isWarframe, w }) {
  const [map, setMap] = useState(entry.map_label ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setMap(entry.map_label ?? ''), [entry.map_label]);
  const guess = entry.map_guess;
  const name = runName(entry, w);
  const kept = images.filter(i => !i.excluded);

  const saveMap = async value => {
    if ((entry.map_label ?? '') === value) return;
    await api.updateEntry(entry.id, { mapLabel: value });
    onPatch('entries', entry.id, { map_label: value || null });
  };
  const move = async (img, dir) => {
    const order = [...images];
    const i = order.findIndex(x => x.id === img.id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await api.orderImages(entry.id, order.map(x => x.id));
    onReload();
  };
  const toggleImage = async img => {
    await api.updateImage(img.id, { excluded: !img.excluded });
    onPatch('images', img.id, { excluded: !img.excluded });
  };

  return (
    <li className={`row ${entry.flags?.length ? 'flagged' : ''}`}>
      <div className="row-num num" aria-label={name}>{entry.kind === 'loose' ? '–' : entry.number}</div>
      <div className="row-main">
        {(entry.text || entry.notes?.length > 0 || entry.flags?.length > 0) && (
          <p className="row-meta">
            {entry.flags?.map((f, i) => <span key={`f${i}`} className="flag">{f}</span>)}
            {entry.notes?.map((note, i) => <span key={`n${i}`} className="note">{note}</span>)}
            {entry.text && <span className="note" title="Written beside this in the doc">{entry.text}</span>}
          </p>
        )}
        {images.length > 0 && (
          <ul className="shots">
            {images.map((img, k) => (
              <li key={img.id} className={img.excluded ? 'excluded' : ''}>
                {img.hash ? (
                  <button className="shot" onClick={() => onView({ ...img, label: `${section.title} ${name}, ${w.shot} ${k + 1} of ${images.length}` })}>
                    <img src={`/thumb/${img.hash}`} alt={`${section.title} ${name}, ${w.shot} ${k + 1}`} loading="lazy" width="132" height="74" />
                  </button>
                ) : <div className="shot missing">Not in the export</div>}
                <div className="shot-bar">
                  <span className="num">{k + 1} of {images.length}</span>
                  {img.flags?.map((f, i) => <span key={i} className="flag">{f}</span>)}
                  <span className="shot-tools">
                    <button className="icon" aria-label={`Move ${w.shot} ${k + 1} earlier`} onClick={() => move(img, -1)} disabled={k === 0}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
                    </button>
                    <button className="icon" aria-label={`Move ${w.shot} ${k + 1} later`} onClick={() => move(img, 1)} disabled={k === images.length - 1}>
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
                    </button>
                    <button className="icon" aria-label={img.excluded ? `Put ${w.shot} ${k + 1} back` : `Leave ${w.shot} ${k + 1} out`} aria-pressed={img.excluded} onClick={() => toggleImage(img)}>
                      {img.excluded
                        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 3v2.5h2.5" /></svg>
                        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>}
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {isWarframe && entry.kind === 'item' && kept.length > 0 && (
          <div className="map">
            <label htmlFor={`map-${entry.id}`}>Map</label>
            <input id={`map-${entry.id}`} name={`map-${entry.id}`} list="arbitration-nodes" autoComplete="off" value={map} placeholder="Pick a node…"
              onChange={e => setMap(e.target.value)} onBlur={e => saveMap(e.target.value.trim())} />
            {guess && !entry.map_label && guess.score >= 0.45 && (
              <button className="quiet small" onClick={() => { setMap(guess.label); saveMap(guess.label); }}>Use {guess.label}?</button>
            )}
            {entry.map_label && guess?.confident && entry.map_label === guess.label && <span className="map-source">Read from the end screen</span>}
            {entry.map_label && (
              <button className="quiet small" disabled={busy} onClick={async () => { setBusy(true); try { await api.applyMapToRest(entry.id); onReload(); } finally { setBusy(false); } }}>
                Use for Rest of {section.title}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
});

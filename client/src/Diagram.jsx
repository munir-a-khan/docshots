import { useEffect, useMemo, useRef, useState } from 'react';
import { STEPS, stepStates, fmtMs } from './steps.js';

const SPEEDS = [1, 10, 50];
const STATUS_TEXT = { idle: 'Waiting', running: 'Running', done: 'Done', warn: 'Done with notes', fail: 'Failed', retry: 'Retrying' };

// Floor plan of a run. The dashed wall is the DocShots server; anything outside it is another system.
// Coordinates are in viewBox units (1000 × 570) and scale with the container.
const ROOMS = {
  link: { x: 20, y: 190, w: 170, h: 130 },
  download: { x: 240, y: 20, w: 470, h: 104 },
  structure: { x: 240, y: 172, w: 220, h: 126 },
  extract: { x: 480, y: 172, w: 230, h: 126 },
  group: { x: 730, y: 172, w: 240, h: 126 },
  check: { x: 730, y: 318, w: 240, h: 126 },
  save: { x: 500, y: 318, w: 210, h: 126 },
  maps: { x: 240, y: 478, w: 470, h: 84 },
};
const STORE = { x: 240, y: 318, w: 220, h: 126 };
const ZONES = [
  { label: 'Your browser', x: 20, y: 178 },
  { label: 'Google Docs', x: 240, y: 12 },
  { label: 'DocShots server', x: 236, y: 145 },
  { label: 'Public game data (Warframe preset)', x: 240, y: 470 },
];
const CORRIDORS = [
  { from: 'link', to: 'download', d: 'M190 255 H215 V72 H240' },
  { from: 'download', to: 'structure', d: 'M350 124 V172' },
  { from: 'structure', to: 'extract', d: 'M460 235 H480' },
  { from: 'extract', to: 'group', d: 'M710 235 H730' },
  { from: 'group', to: 'check', d: 'M850 298 V318' },
  { from: 'check', to: 'save', d: 'M730 381 H710' },
  { from: 'save', to: 'maps', d: 'M605 444 V478' },
  { from: 'extract', to: 'store', d: 'M490 298 V381 H460' },
];

const finished = s => s === 'done' || s === 'warn';

export default function Diagram({ events, live }) {
  const [replay, setReplay] = useState(null); // { cursor, speed, playing } or { step: n }
  const [open, setOpen] = useState(null);
  const timer = useRef(null);
  const total = events.length ? events[events.length - 1].at : 0;
  const keyEvents = useMemo(() => events.filter(e => e.status !== 'progress'), [events]);

  const visible = useMemo(() => {
    if (!replay) return events;
    if ('step' in replay) return keyEvents.slice(0, replay.step);
    return events.filter(e => e.at <= replay.cursor);
  }, [events, keyEvents, replay]);
  const states = useMemo(() => stepStates(visible), [visible]);
  const extractData = states.extract.data;

  useEffect(() => {
    clearInterval(timer.current);
    if (!replay?.playing) return undefined;
    const tick = 50;
    timer.current = setInterval(() => {
      setReplay(r => {
        if (!r?.playing) return r;
        const cursor = r.cursor + tick * r.speed;
        return cursor >= total ? { ...r, cursor: total, playing: false } : { ...r, cursor };
      });
    }, tick);
    return () => clearInterval(timer.current);
  }, [replay?.playing, replay?.speed, total]);

  const clock = replay ? ('step' in replay ? (visible[visible.length - 1]?.at ?? 0) : Math.round(replay.cursor)) : null;

  return (
    <section className="plan" aria-labelledby="plan-title">
      <div className="plan-head">
        <div>
          <h2 id="plan-title">How this job worked</h2>
          <p className="muted">Every room is a real step with its measured time. Select a room to see what it did.</p>
        </div>
        <div className="replay" role="group" aria-label="Replay">
          {replay ? (
            <>
              <span className="clock" aria-live="off">{fmtMs(clock)} of {fmtMs(total)}</span>
              {'step' in replay ? (
                <button onClick={() => setReplay(r => ({ step: Math.min(keyEvents.length, r.step + 1) }))} disabled={replay.step >= keyEvents.length}>Next Event</button>
              ) : (
                <button onClick={() => setReplay(r => ({ ...r, playing: !r.playing, cursor: r.cursor >= total ? 0 : r.cursor }))}>{replay.playing ? 'Pause' : 'Play'}</button>
              )}
              <button className="quiet" onClick={() => setReplay(null)}>Show Final State</button>
            </>
          ) : (
            <>
              <span className="muted">Replay at</span>
              {SPEEDS.map(s => (
                <button key={s} className="quiet" disabled={live || !events.length} onClick={() => setReplay({ cursor: 0, speed: s, playing: true })}>{s}×</button>
              ))}
              <button className="quiet" disabled={live || !events.length} onClick={() => setReplay({ step: 1 })}>Step by Step</button>
            </>
          )}
        </div>
      </div>

      {replay && !('step' in replay) && (
        <input className="scrub" type="range" min={0} max={total} value={replay.cursor} aria-label="Replay position"
          onChange={e => setReplay(r => ({ ...r, cursor: Number(e.target.value), playing: false }))} />
      )}

      <svg className="floor" viewBox="0 0 1000 570" role="group" aria-label="Job steps as a floor plan">
        <rect className="hull" x="222" y="152" width="764" height="306" rx="4" />
        {ZONES.map(z => <text key={z.label} className="zone" x={z.x} y={z.y}>{z.label}</text>)}
        {CORRIDORS.map(c => {
          const src = c.from === 'store' ? 'done' : states[c.from].status;
          const dst = c.to === 'store' ? (states.extract.status === 'running' ? 'running' : 'idle') : states[c.to].status;
          const cls = dst === 'running' && finished(src) ? 'flowing' : finished(src) ? 'lit' : '';
          return <path key={`${c.from}-${c.to}`} className={`corridor ${cls}`} d={c.d} />;
        })}

        <foreignObject x={STORE.x} y={STORE.y} width={STORE.w} height={STORE.h}>
          <div className="room store">
            <span className="room-title">Image storage</span>
            <span className="room-detail">{extractData ? `${extractData.saved} images in ${extractData.storage}, ${extractData.reused} reused` : 'Files named by content hash, so repeats are stored once.'}</span>
          </div>
        </foreignObject>

        {STEPS.map(step => {
          const r = ROOMS[step.id];
          const s = states[step.id];
          return (
            <foreignObject key={step.id} x={r.x} y={r.y} width={r.w} height={r.h}>
              <button className={`room ${s.status} ${open === step.id ? 'open' : ''}`} onClick={() => setOpen(open === step.id ? null : step.id)}
                aria-expanded={open === step.id} aria-label={`${step.title}: ${STATUS_TEXT[s.status]}. ${s.detail}`}>
                <span className="room-title">{step.title}</span>
                <span className="room-detail">{s.detail || step.blurb}</span>
                <span className="room-foot"><span className={`state ${s.status}`}>{STATUS_TEXT[s.status]}</span>{s.duration != null && <span className="num">{fmtMs(s.duration)}</span>}</span>
              </button>
            </foreignObject>
          );
        })}
      </svg>

      {/* Narrow screens get the same steps as a vertical route. */}
      <ol className="route">
        {STEPS.map(step => {
          const s = states[step.id];
          return (
            <li key={step.id} className={s.status}>
              <button className={`room ${s.status}`} onClick={() => setOpen(open === step.id ? null : step.id)} aria-expanded={open === step.id}>
                <span className="room-where">{step.layer}</span>
                <span className="room-title">{step.title}</span>
                <span className="room-detail">{s.detail || step.blurb}</span>
                <span className="room-foot"><span className={`state ${s.status}`}>{STATUS_TEXT[s.status]}</span>{s.duration != null && <span className="num">{fmtMs(s.duration)}</span>}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {open && <StepInspector step={STEPS.find(s => s.id === open)} state={states[open]} onClose={() => setOpen(null)} />}
    </section>
  );
}

function StepInspector({ step, state, onClose }) {
  const withData = [...state.log].reverse().find(e => e.data);
  const log = state.log.filter((e, i, all) => e.status !== 'progress' || i === all.length - 1 || all[i + 1].status !== 'progress');
  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>{step.title} <span className="muted">in {step.layer}</span></h3>
        <button className="quiet" onClick={onClose}>Close</button>
      </div>
      <p className="muted">{step.blurb}</p>
      <div className="inspector-cols">
        <div>
          <h4>What happened</h4>
          {log.length ? (
            <table className="log">
              <tbody>
                {log.map(e => (
                  <tr key={e.seq} className={e.status}><td className="num">{fmtMs(e.at)}</td><td>{STATUS_TEXT[e.status] ?? e.status}</td><td>{e.detail}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">This step has not started.</p>}
        </div>
        {withData && (
          <div>
            <h4>Data it produced</h4>
            <pre>{JSON.stringify(withData.data, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

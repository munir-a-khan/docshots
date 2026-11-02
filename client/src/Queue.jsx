import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { FrameIcon } from './Results.jsx';

const DISCORD_MAX_FILES = 10;

// Turns the chosen entries into messages for Discord, a forum or any chat: a text line, then up to `maxImages` images, then "send".
// An entry with more images than fit keeps going in the next message as "(cont.)" so nothing is dropped.
export function buildMessages({ sections, entries, images }, selected, { perMessage, maxImages, withMap, w }) {
  const sectionOrder = sections.filter(s => selected.size === 0 || selected.has(s.id));
  const imgsByEntry = new Map();
  for (const img of images) {
    if (img.excluded || !img.hash) continue;
    if (!imgsByEntry.has(img.entry_id)) imgsByEntry.set(img.entry_id, []);
    imgsByEntry.get(img.entry_id).push(img);
  }
  const messages = [];
  const skipped = [];
  let cur = null;
  const flush = () => { if (cur) messages.push(cur); cur = null; };

  for (const section of sectionOrder) {
    for (const entry of entries.filter(e => e.section_id === section.id)) {
      const imgs = (imgsByEntry.get(entry.id) ?? []).sort((a, b) => a.ord - b.ord);
      const name = entry.kind === 'loose' ? `${section.title} (loose)` : `${entry.number ?? '?'}.`;
      if (!imgs.length) { skipped.push(`${section.title} ${w.item} ${entry.number ?? '?'}`); continue; }
      for (let k = 0; k < imgs.length; k += maxImages) {
        const chunk = imgs.slice(k, k + maxImages);
        const line = k === 0 ? [name, withMap && entry.map_label].filter(Boolean).join(' ') : `${name} (cont.)`;
        const fits = cur && cur.entryCount < perMessage && cur.images.length + chunk.length <= maxImages && k === 0;
        if (!fits) { flush(); cur = { section: section.title, frame: section.frame, lines: [], images: [], entryCount: 0 }; }
        cur.lines.push(line);
        cur.entryCount++;
        chunk.forEach((img, i) => cur.images.push({ ...img, label: `${section.title} ${w.item} ${name.replace(/\.$/, '')}, ${w.shot} ${k + i + 1} of ${imgs.length}` }));
      }
    }
  }
  flush();
  return { messages, skipped };
}

function flatten(messages) {
  const steps = [];
  messages.forEach((m, mi) => {
    steps.push({ kind: 'text', text: m.lines.join('\n'), mi });
    m.images.forEach((img, ii) => steps.push({ kind: 'image', img, mi, ii }));
    steps.push({ kind: 'send', mi });
  });
  return steps;
}

async function pngBlob(hash) {
  const blob = await (await fetch(`/img/${hash}`)).blob();
  if (blob.type === 'image/png') return blob;
  // Clipboards only take PNG reliably; redraw anything else.
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function copyStep(step) {
  if (step.kind === 'text') { await navigator.clipboard.writeText(step.text); return; }
  if (step.kind === 'image') {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('unsupported');
    // Passing the promise (not the blob) keeps Safari's user-gesture rule happy.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(step.img.hash) })]);
  }
}

export default function Queue({ runId, data, selected, w }) {
  const [perMessage, setPerMessage] = useState(1);
  const [maxImages, setMaxImages] = useState(3);
  const [withMap, setWithMap] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState(null);
  const [webhook, setWebhook] = useState('');
  const [hookLog, setHookLog] = useState([]);
  const [sending, setSending] = useState(false);
  const stopSending = useRef(false);
  const listRef = useRef(null);

  const { messages, skipped } = useMemo(
    () => buildMessages(data, selected, { perMessage, maxImages, withMap: withMap && data.run.preset === 'warframe', w }),
    [data, selected, perMessage, maxImages, withMap, w]);
  const steps = useMemo(() => flatten(messages), [messages]);
  const key = `${[...selected].sort().join('-') || 'all'}|${perMessage}|${maxImages}`;
  const step = steps[cursor];
  const loaded = useRef(null);

  // Resume where this selection was left off, on any device.
  useEffect(() => {
    let live = true;
    loaded.current = null;
    api.progress(runId, key).then(({ cursor: c }) => { if (live) { setCursor(Math.min(c, Math.max(0, steps.length - 1))); loaded.current = key; } });
    return () => { live = false; };
  }, [runId, key, steps.length]);
  useEffect(() => {
    if (loaded.current !== key) return;
    const t = setTimeout(() => api.saveProgress(runId, key, cursor).catch(() => {}), 400);
    return () => clearTimeout(t);
  }, [runId, key, cursor]);

  useEffect(() => {
    // Scroll only the message list, never the page.
    const list = listRef.current;
    const el = list?.querySelector('.msg.current');
    if (list && el) list.scrollTo({ top: el.offsetTop - list.offsetTop - list.clientHeight / 3 });
  }, [step?.mi]);

  const next = useCallback(async () => {
    if (!step) return;
    try {
      await copyStep(step);
      setStatus(step.kind === 'text' ? { ok: true, text: `Copied “${step.text.split('\n')[0]}”. Paste it where you're posting.` }
        : step.kind === 'image' ? { ok: true, text: `Copied ${step.img.label}. Paste it where you're posting.` }
          : { ok: true, text: `Message ${step.mi + 1} sent. Copy the next one when you're ready.` });
      setCursor(c => Math.min(c + 1, steps.length));
    } catch (err) {
      if (step.kind === 'image') {
        window.open(`/img/${step.img.hash}`, '_blank', 'noopener');
        setStatus({ ok: false, text: 'This browser cannot put images on the clipboard, so the image opened in a new tab: right-click it and choose Copy Image.' });
        setCursor(c => Math.min(c + 1, steps.length));
      } else {
        setStatus({ ok: false, text: `Could not copy (${err.message}). Click this page first, then try again.` });
      }
    }
  }, [step, steps.length]);
  const back = useCallback(() => setCursor(c => Math.max(0, c - 1)), []);

  useEffect(() => {
    const onKey = e => {
      if (e.target.closest('input, textarea, select')) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back]);

  const sendMessage = async mi => {
    const m = messages[mi];
    const started = performance.now();
    const res = await api.discord({ url: webhook, content: m.lines.join('\n'), hashes: m.images.map(i => i.hash) });
    setHookLog(l => [{ mi, ok: true, text: `Message ${mi + 1} sent (${m.images.length} images, ${Math.round(performance.now() - started)} ms${res.attempts > 1 ? `, waited out ${res.attempts - 1} rate limit` : ''})` }, ...l]);
  };
  const sendFromHere = async all => {
    setSending(true);
    stopSending.current = false;
    let mi = step?.mi ?? 0;
    try {
      do {
        await sendMessage(mi);
        mi++;
        const firstOfNext = steps.findIndex(s => s.mi === mi);
        setCursor(firstOfNext === -1 ? steps.length : firstOfNext);
      } while (all && mi < messages.length && !stopSending.current);
    } catch (err) {
      setHookLog(l => [{ mi, ok: false, text: `Message ${mi + 1} not sent: ${err.message}. Nothing was skipped; fix it and send again.` }, ...l]);
    } finally {
      setSending(false);
    }
  };

  const done = cursor >= steps.length;
  const imgCount = messages.reduce((n, m) => n + m.images.length, 0);
  const current = done ? null : messages[step.mi];

  return (
    <div className="queue">
      <details className="queue-settings">
        <summary>Message format: {perMessage === 1 ? `one ${w.item}` : `up to ${perMessage} ${w.items}`} per message, up to {maxImages} {w.shots}{withMap && data.run.preset === 'warframe' ? ', map name after the number' : ''}</summary>
        <div className="settings-grid">
          <label>{w.Items} per message
            <input type="number" inputMode="numeric" min={1} max={10} value={perMessage} onChange={e => setPerMessage(Math.max(1, Math.min(10, +e.target.value || 1)))} />
          </label>
          <label>{w.shots[0].toUpperCase() + w.shots.slice(1)} per message
            <input type="number" inputMode="numeric" min={1} max={DISCORD_MAX_FILES} value={maxImages} onChange={e => setMaxImages(Math.max(1, Math.min(DISCORD_MAX_FILES, +e.target.value || 1)))} />
          </label>
          {data.run.preset === 'warframe' && <label className="choice"><input type="checkbox" checked={withMap} onChange={e => setWithMap(e.target.checked)} /> Put the map name after the number</label>}
        </div>
      </details>

      <div className="queue-main">
        <section className="stage" aria-label="Next paste">
          <p className="stage-progress">
            <span>{done ? 'Finished' : `Message ${step.mi + 1} of ${messages.length}`}</span>
            <span className="muted">{messages.length} messages, {imgCount} screenshots{skipped.length ? `. Skipped ${skipped.length} without screenshots: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}` : ''}</span>
          </p>
          <div className="progress" role="progressbar" aria-label="Pasting progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={cursor}><span style={{ transform: `scaleX(${steps.length ? cursor / steps.length : 0})` }} /></div>

          <div className="stage-card">
            {current?.frame && <p className="stage-frame"><FrameIcon frame={current.frame} size={40} /><span>{current.frame.name}<span className="muted">{current.section}</span></span></p>}
            {done ? <p className="stage-big">Every message in this selection is done.</p> : (
              <>
                <p className="stage-what">
                  {step.kind === 'text' ? 'Next: copy the text' : step.kind === 'image' ? `Next: copy screenshot ${step.ii + 1} of ${current.images.length}` : 'Next: send the message'}
                </p>
                {/* The whole message being built: copied pieces dim, the next one is framed in red. */}
                <ol className="compose" aria-label={`Message ${step.mi + 1}`}>
                  <li className={`piece text ${step.kind === 'text' ? 'next' : 'copied'}`}>
                    <span className="piece-text">{current.lines.join('\n')}</span>
                  </li>
                  {current.images.map((img, ii) => {
                    const state = step.kind === 'image' ? (ii < step.ii ? 'copied' : ii === step.ii ? 'next' : 'later') : step.kind === 'send' ? 'copied' : 'later';
                    return (
                      <li key={img.id} className={`piece image ${state}`}>
                        <img src={`/thumb/${img.hash}`} alt={img.label} width="320" height="180" />
                        <span className="piece-label">{ii + 1} of {current.images.length}{state === 'copied' ? ', copied' : ''}</span>
                      </li>
                    );
                  })}
                </ol>
                {step.kind === 'send' && <p className="stage-big">Send it where you're posting, then come back.</p>}
              </>
            )}
          </div>
          <div className="stage-actions">
            <button className="quiet" onClick={back} disabled={cursor === 0}>Back</button>
            <button className="primary big" onClick={next} disabled={done}>{step?.kind === 'send' ? 'Sent, Next Message' : step?.kind === 'image' ? 'Copy Screenshot' : 'Copy Text'}</button>
          </div>
          <p className="hint">Press <kbd>Space</kbd> to copy the next item and <kbd>Backspace</kbd> to go back. Your place is saved, so you can stop and pick up later on any device.</p>
          <p className={`status ${status?.ok === false ? 'bad' : ''}`} role="status" aria-live="polite">{status?.text ?? ''}</p>

          <div className="queue-extra">
            <a className="button quiet" href={`/api/runs/${runId}/zip${selected.size ? `?sections=${[...selected].join(',')}` : ''}`} download>Download as Zip</a>
            <details className="webhook">
              <summary>Send through your own Discord webhook</summary>
              <p className="muted">For a server or thread where you can create a webhook. The address stays in this tab and is never saved.</p>
              <label htmlFor="hook">Webhook address</label>
              <input id="hook" name="webhook" type="password" autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" value={webhook} onChange={e => setWebhook(e.target.value)} />
              <div className="row-actions">
                <button disabled={!webhook || sending || done} onClick={() => sendFromHere(false)}>Send Message {done ? '' : step.mi + 1}</button>
                <button disabled={!webhook || sending || done} onClick={() => sendFromHere(true)}>Send All Remaining</button>
                {sending && <button className="quiet" onClick={() => { stopSending.current = true; }}>Stop</button>}
              </div>
              {hookLog.length > 0 && <ul className="hook-log">{hookLog.map((l, i) => <li key={i} className={l.ok ? 'ok' : 'bad'}>{l.text}</li>)}</ul>}
            </details>
          </div>
        </section>

        <section className="feed" aria-label="Messages">
          <ol ref={listRef}>
            {messages.map((m, mi) => (
              <li key={mi} className={`msg ${step?.mi === mi ? 'current' : ''} ${(done || mi < (step?.mi ?? 0)) ? 'past' : ''}`}>
                <button className={`msg-jump ${m.frame ? 'with-frame' : ''}`} onClick={() => setCursor(steps.findIndex(x => x.mi === mi))} aria-current={step?.mi === mi ? 'step' : undefined}>
                  {m.frame && <FrameIcon frame={m.frame} size={40} />}
                  <span className="msg-text">{m.lines.join('\n')}</span>
                  <span className="msg-imgs">{m.images.map(img => <img key={img.id} src={`/thumb/${img.hash}`} alt="" width="96" height="54" loading="lazy" />)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

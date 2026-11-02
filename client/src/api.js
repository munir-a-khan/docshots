async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  startRun: body => call('POST', '/api/runs', body),
  config: () => call('GET', '/api/config'),
  runs: () => call('GET', '/api/runs'),
  run: id => call('GET', `/api/runs/${id}`),
  updateEntry: (id, body) => call('PATCH', `/api/entries/${id}`, body),
  applyMapToRest: id => call('POST', `/api/entries/${id}/apply-map-to-rest`),
  updateImage: (id, body) => call('PATCH', `/api/images/${id}`, body),
  orderImages: (entryId, imageIds) => call('POST', `/api/entries/${entryId}/order`, { imageIds }),
  progress: (runId, key) => call('GET', `/api/progress/${runId}/${encodeURIComponent(key)}`),
  saveProgress: (runId, key, cursor) => call('PUT', `/api/progress/${runId}/${encodeURIComponent(key)}`, { cursor }),
  nodes: () => call('GET', '/api/nodes'),
  discord: body => call('POST', '/api/discord', body),
};

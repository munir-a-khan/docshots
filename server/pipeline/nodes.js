// The closed list of arbitration nodes, built from two public community sources and cached for a day:
// browse.wf's hourly arbitration history (which node ids have ever been arbitrations) and WFCD's node names.
import { one, q } from '../db.js';

const ARBYS = 'https://browse.wf/arbys.txt';
const SOLNODES = 'https://raw.githubusercontent.com/WFCD/warframe-worldstate-data/master/data/solNodes.json';
const DAY = 24 * 3600 * 1000;
const FACTION_ON_SCREEN = { Infested: 'INFESTATION' };

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'DocShots/1.0' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

// Returns { nodes, from: 'live' | 'cache' | 'stale cache', note }.
export async function loadArbitrationNodes() {
  const cached = await one("select data, fetched_at from cache where key = 'arbitration-nodes'");
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < DAY) return { nodes: cached.data, from: 'cache' };
  try {
    const [arbys, sol] = await Promise.all([getText(ARBYS), getText(SOLNODES).then(JSON.parse)]);
    const ids = new Set(arbys.trim().split('\n').map(l => l.split(',')[1]?.trim()).filter(Boolean));
    const nodes = [...ids].filter(id => sol[id]).map(id => {
      const n = sol[id];
      const [name, planet = ''] = n.value.split(' (');
      return {
        id, label: n.value, name, planet: planet.replace(')', ''),
        enemy: n.enemy, type: n.type,
        screen: `${n.type.startsWith('Dark Sector') ? 'DARK SECTOR ' : ''}${n.value} - ${FACTION_ON_SCREEN[n.enemy] ?? n.enemy} - ${n.type.replace('Dark Sector ', '')}`.toUpperCase(),
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    await q("insert into cache (key, data, fetched_at) values ('arbitration-nodes', $1, now()) on conflict (key) do update set data = excluded.data, fetched_at = now()", [JSON.stringify(nodes)]);
    return { nodes, from: 'live' };
  } catch (err) {
    if (cached) return { nodes: cached.data, from: 'stale cache', note: err.message };
    throw err;
  }
}

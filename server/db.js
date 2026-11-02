// Postgres when DATABASE_URL is set (Replit), otherwise an embedded PGlite database on disk for local work.
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
create table if not exists runs (
  id serial primary key,
  doc_id text not null,
  link text not null,
  title text,
  preset text not null default 'warframe',
  status text not null default 'running',
  source text,
  stats jsonb not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists events (
  id serial primary key,
  run_id int not null references runs(id) on delete cascade,
  seq int not null,
  at_ms int not null,
  step text not null,
  status text not null,
  detail text,
  duration_ms int,
  data jsonb
);
create index if not exists events_run on events(run_id, seq);
create table if not exists sections (
  id serial primary key,
  run_id int not null references runs(id) on delete cascade,
  idx int not null,
  title text not null,
  notes jsonb not null default '[]'
);
create table if not exists entries (
  id serial primary key,
  run_id int not null references runs(id) on delete cascade,
  section_id int not null references sections(id) on delete cascade,
  idx int not null,
  number text,
  kind text not null default 'item',
  text text,
  notes jsonb not null default '[]',
  flags jsonb not null default '[]',
  map_guess jsonb,
  map_label text
);
create index if not exists entries_run on entries(run_id, idx);
create table if not exists images (
  id serial primary key,
  run_id int not null references runs(id) on delete cascade,
  entry_id int references entries(id) on delete cascade,
  ord int not null,
  ref_key text not null,
  hash text,
  mime text,
  width int,
  height int,
  bytes int,
  excluded boolean not null default false,
  flags jsonb not null default '[]'
);
create index if not exists images_entry on images(entry_id, ord);
create table if not exists queue_progress (
  run_id int not null references runs(id) on delete cascade,
  key text not null,
  cursor int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (run_id, key)
);
create table if not exists blobs (
  hash text primary key,
  b64sha1 text unique,
  mime text not null,
  width int,
  height int,
  bytes int,
  ocr jsonb,
  created_at timestamptz not null default now()
);
alter table runs add column if not exists owner text;
create index if not exists runs_owner on runs(owner, id);
create table if not exists cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
`;

let client;

export async function initDb() {
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.resolve('data/pglite');
    fs.mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) await client.query(stmt);
}

export async function q(sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows;
}

export async function one(sql, params = []) {
  return (await q(sql, params))[0];
}

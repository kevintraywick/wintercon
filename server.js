// WinterCon organizing site — Express server with shared-state API.
// Static pages + a tiny key/value store so people.html, the outreach map,
// the planners, mindmap, journey notes, and the ops dashboard are shared
// across all visitors instead of trapped in each browser's localStorage.
//
// Storage: Postgres when DATABASE_URL is set (Railway), else a local JSON
// file (dev / fallback). Editing is open unless ORGANIZER_KEY is set, in
// which case writes require the x-organizer-key header ("protect later"
// is a one-env-var flip).

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const KEY_PREFIX = 'wincon_';
const MAX_VALUE_BYTES = 400 * 1024; // per key
const ORGANIZER_KEY = (process.env.ORGANIZER_KEY || '').trim(); // empty = open editing

// ---------- storage backends ----------
let store;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('.railway.internal') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  store = {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS shared_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )`);
    },
    async getSince(since) {
      const r = since
        ? await pool.query('SELECT key, value, updated_at FROM shared_state WHERE updated_at > $1', [since])
        : await pool.query('SELECT key, value, updated_at FROM shared_state');
      const out = {};
      for (const row of r.rows) out[row.key] = { v: row.value, t: Number(row.updated_at) };
      return out;
    },
    async put(key, value, ts) {
      await pool.query(
        `INSERT INTO shared_state (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
        [key, value, ts]
      );
    },
    async del(key, ts) {
      // empty-string tombstone so pollers learn about deletions
      await this.put(key, '', ts);
    },
  };
} else {
  const FILE = process.env.DATA_FILE || path.join(__dirname, 'shared_state.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; }
  const persist = () => fs.writeFile(FILE, JSON.stringify(cache), () => {});
  store = {
    kind: 'file',
    async init() {},
    async getSince(since) {
      const out = {};
      for (const [k, rec] of Object.entries(cache)) {
        if (!since || rec.t > since) out[k] = rec;
      }
      return out;
    },
    async put(key, value, ts) { cache[key] = { v: value, t: ts }; persist(); },
    async del(key, ts) { cache[key] = { v: '', t: ts }; persist(); },
  };
}

// ---------- API ----------
app.use(express.json({ limit: '500kb' }));

function requireEditAccess(req, res, next) {
  if (!ORGANIZER_KEY) return next(); // open editing
  if ((req.get('x-organizer-key') || '') === ORGANIZER_KEY) return next();
  res.status(403).json({ error: 'organizer key required' });
}

function validKey(key) {
  return typeof key === 'string' && key.startsWith(KEY_PREFIX) && key.length <= 128 && /^[\w-]+$/.test(key);
}

app.get('/healthz', (_req, res) => res.json({ ok: true, storage: store.kind }));

// ---------- DM Zone login (emoji-chip passcode, Weldon-style) ----------
// Change the code by setting the DM_CODE env var on Railway (an emoji string).
const DM_CODE = (process.env.DM_CODE || '🐉❄️🎲🗡️').trim();
app.post('/api/dm/login', (req, res) => {
  const code = req.body && req.body.code;
  const attempt = Array.isArray(code) ? code.join('') : String(code || '');
  if (attempt === DM_CODE) return res.json({ ok: true });
  res.status(403).json({ ok: false });
});

// Full or incremental state. ?since=<ms> returns only newer entries.
app.get('/api/state', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const states = await store.getSince(since);
    res.json({ states, now: Date.now(), protected: Boolean(ORGANIZER_KEY) });
  } catch (e) {
    res.status(500).json({ error: 'storage unavailable' });
  }
});

app.put('/api/state/:key', requireEditAccess, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'invalid key' });
  const v = req.body && req.body.v;
  if (typeof v !== 'string') return res.status(400).json({ error: 'body must be {"v": "<string>"}' });
  if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) return res.status(413).json({ error: 'value too large' });
  try {
    const ts = Date.now();
    await store.put(key, v, ts);
    res.json({ ok: true, t: ts });
  } catch (e) {
    res.status(500).json({ error: 'storage unavailable' });
  }
});

app.delete('/api/state/:key', requireEditAccess, async (req, res) => {
  const key = req.params.key;
  if (!validKey(key)) return res.status(400).json({ error: 'invalid key' });
  try {
    const ts = Date.now();
    await store.del(key, ts);
    res.json({ ok: true, t: ts });
  } catch (e) {
    res.status(500).json({ error: 'storage unavailable' });
  }
});

// ---------- static site ----------
app.use(express.static(__dirname, { extensions: ['html'] }));
app.use((_req, res) => {
  res.status(404).send('<h1>404</h1><p>Page not found. <a href="/">Back to the WinterCon table of contents</a></p>');
});

store.init()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`WinterCon site + API (${store.kind}) listening on ${PORT}`)))
  .catch((e) => { console.error('storage init failed:', e); process.exit(1); });

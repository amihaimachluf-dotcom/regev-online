// רגב online server: static files + Socket.io rooms (host-authoritative simulation, server-side persistence)
const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), { Server } = require('socket.io');
const PORT = process.env.PORT || 3000, MAX = 10, MAX_EDITS = 100000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'), DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const app = express(); app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));
const server = http.createServer(app), io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

const rooms = new Map(); // code -> { seed, edits: Map, chests: Map, env, players: Map, host }
let dirty = false;
function newRoom() { return { seed: null, edits: new Map(), chests: new Map(), signs: new Map(), env: null, players: new Map(), host: null }; }
try {
  const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const code in j) { const r = newRoom(), o = j[code]; r.seed = o.seed; r.env = o.env || null;
    for (const e of o.edits || []) r.edits.set(e.x + ',' + e.y + ',' + e.z, e);
    for (const k in o.chests || {}) r.chests.set(+k, o.chests[k]); for (const v of o.signs || []) r.signs.set(v.x + ',' + v.y + ',' + v.z, v); rooms.set(code, r); }
  console.log('loaded', rooms.size, 'rooms from', DATA_FILE);
} catch (e) { if (e.code !== 'ENOENT') console.warn('state load failed', e.message); }
function save() {
  if (!dirty) return; dirty = false;
  const out = {};
  for (const [code, r] of rooms) if (r.seed != null || r.edits.size || r.chests.size) out[code] = { seed: r.seed, env: r.env, edits: [...r.edits.values()], chests: Object.fromEntries(r.chests), signs: [...r.signs.values()] };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
  catch (e) { console.warn('save failed', e.message); }
}
setInterval(save, 20000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { dirty = true; save(); process.exit(0); });

// ---- light anti-cheat: per-socket rate limits ----
const LIMITS = { state: 40, edits: 40, relay: 120, fx: 30, sign: 5, chestSet: 30, chestGet: 20, snap: 30, env: 5, hb: 10, world: 3 };
function limiter() { const b = {}; return (ev) => { const L = LIMITS[ev]; if (!L) return true; const now = Date.now(), t = b[ev] || (b[ev] = { n: 0, t: now }); if (now - t.t > 1000) { t.n = 0; t.t = now; } return ++t.n <= L; }; }
const active = (p) => p && Date.now() - p.beat < 3500 && !p.hidden;
function electHost(r, code) {
  const cur = r.players.get(r.host);
  if (cur && active(cur)) return;
  let next = null; for (const p of r.players.values()) if (active(p)) { next = p; break; }
  if (!next && cur) return;                       // nobody better: keep the current host
  if (!next) next = r.players.values().next().value;
  const id = next ? next.id : null;
  if (id !== r.host) { r.host = id; if (id) io.to(code).emit('host', { id, env: r.env }); }
}
setInterval(() => { for (const [code, r] of rooms) if (r.players.size) electHost(r, code); }, 1000);

io.on('connection', (s) => {
  let r = null, code = null;
  const allow = limiter(), on = s.on.bind(s);
  s.on = (ev, fn) => on(ev, (...a) => { if (allow(ev)) { try { fn(...a); } catch (e) { console.warn('handler', ev, e.message); } } });
  const isHost = () => r && r.host === s.id;
  s.on('join', ({ room, name } = {}) => {
    if (r) return;
    code = String(room || 'main').slice(0, 32);
    if (!rooms.has(code)) rooms.set(code, newRoom());
    const R = rooms.get(code);
    if (R.players.size >= MAX) return s.emit('full');
    r = R; const me = { id: s.id, name: String(name || 'player').slice(0, 16), beat: Date.now(), hidden: false };
    s.join(code);
    const oldHost = r.host;
    if (!r.host || !r.players.has(r.host) || !active(r.players.get(r.host))) r.host = s.id;
    s.emit('joined', { seed: r.seed, edits: [...r.edits.values()], chests: Object.fromEntries(r.chests), signs: [...r.signs.values()], env: r.env, players: [...r.players.values()], host: r.host });
    r.players.set(s.id, me); s.to(code).emit('pjoin', me);
    if (oldHost && oldHost !== r.host && r.players.has(oldHost)) io.to(code).emit('host', { id: r.host, env: r.env });
  });
  s.on('world', ({ seed } = {}) => { if (r && r.seed == null && Number.isFinite(seed)) { r.seed = seed | 0; dirty = true; s.to(code).emit('seed', r.seed); } });
  s.on('state', (d) => { if (!r || !d) return; const p = r.players.get(s.id); if (![d.x, d.y, d.z].every(Number.isFinite) || Math.abs(d.x) > 3e7 || Math.abs(d.z) > 3e7) return; p.beat = Date.now(); Object.assign(p, { ride: d.ride && Number.isFinite(+d.ride.x) ? { nid: String(d.ride.nid).slice(0, 24), x: +d.ride.x, y: +d.ride.y, z: +d.ride.z, yaw: +d.ride.yaw } : null, rd: !!d.rd, x: +d.x, y: +d.y, z: +d.z, yaw: +d.yaw, pitch: +d.pitch, sn: !!d.sn, sw: !!d.sw, hp: +d.hp, dead: !!d.dead }); s.volatile.to(code).emit('state', p); });
  s.on('edits', (arr) => {
    if (!r || !Array.isArray(arr)) return; const out = [];
    const me = r.players.get(s.id), host = r.host === s.id, pl = [...r.players.values()].filter((p) => Number.isFinite(p.x));
    let rejected = 0;
    for (const e of arr.slice(0, 5000)) { if (!e) continue; const ed = { x: e.x | 0, y: e.y | 0, z: e.z | 0, id: e.id & 1023, m: e.m & 255 }, k = ed.x + ',' + ed.y + ',' + ed.z;
      if (ed.y < 0 || ed.y > 255) { rejected++; continue; }
      // non-host players may only edit near themselves (reach + lag); the host simulates near any player
      if (!host) { if (!me || !Number.isFinite(me.x) || Math.hypot(ed.x - me.x, ed.z - me.z) > 16 || Math.abs(ed.y - me.y) > 16) { rejected++; continue; } }
      else if (pl.length && !pl.some((p) => Math.hypot(ed.x - p.x, ed.z - p.z) < 220)) { rejected++; continue; }
      r.edits.delete(k); r.edits.set(k, ed); out.push(ed); }
    while (r.edits.size > MAX_EDITS) r.edits.delete(r.edits.keys().next().value);
    if (rejected) s.emit('rejected', rejected);
    dirty = true; if (out.length) s.to(code).emit('edits', out);
  });
  s.on('chestGet', (k) => { if (r) s.emit('chestData', { k: +k, arr: r.chests.get(+k) || null }); });
  s.on('chestSet', (d) => {
    if (!r || !d) return; const k = +d.k;
    if (Array.isArray(d.arr) && d.arr.some(Boolean)) r.chests.set(k, d.arr.slice(0, 27)); else r.chests.delete(k);
    dirty = true; s.to(code).emit('chest', { k, arr: Array.isArray(d.arr) ? d.arr : new Array(27).fill(null) });
  });
  s.on('env', (d) => { if (isHost() && d) { r.env = d; dirty = true; s.volatile.to(code).emit('env', d); } });
  s.on('hb', (d) => { if (!r) return; const p = r.players.get(s.id); if (p) { p.beat = Date.now(); const was = p.hidden; p.hidden = !!(d && d.hidden); if (p.hidden && !was && r.host === s.id) electHost(r, code); } });
  s.on('sign', (d) => { if (!r || !d) return; const v = { x: d.x | 0, y: d.y | 0, z: d.z | 0, text: String(d.text || '').slice(0, 60) }, me = r.players.get(s.id), k = v.x + ',' + v.y + ',' + v.z;
    if (me && Number.isFinite(me.x) && Math.hypot(v.x - me.x, v.z - me.z) > 16) return;
    if (v.text) r.signs.set(k, v); else r.signs.delete(k); dirty = true; s.to(code).emit('sign', v); });
  s.on('fx', (list) => { if (r && Array.isArray(list)) s.volatile.to(code).emit('fx', list.slice(0, 40)); });
  s.on('snap', (d) => { if (isHost()) s.volatile.to(code).emit('snap', d); });
  s.on('relay', (m) => {
    if (!r || !m) return; const to = m.to === 'host' ? r.host : m.to;
    if (!to || to === s.id || !r.players.has(to)) return;
    m.from = s.id; io.to(to).emit('relay', m);
  });
  s.on('disconnect', () => {
    if (!r) return; r.players.delete(s.id); io.to(code).emit('pleave', s.id);
    if (r.host === s.id) { r.host = null; electHost(r, code); }
  });
});
server.listen(PORT, () => console.log('listening on ' + PORT));

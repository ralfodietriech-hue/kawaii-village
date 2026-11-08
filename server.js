/* =====================================================================
   Kawaii Village 3D - multiplayer server (Node.js + Socket.io)
   - Serves the game from ./public (index.html)
   - Players create / join a ROOM with a 5-letter code
   - Positions (x,y,z), rotation and a few animation flags are relayed ~15x per second
   - Chat + emotes are relayed too. Each player keeps their OWN save game; only presence is shared.

   Run:   npm install && npm start      (then open http://localhost:3000)
   Env:   PORT (3000)  MAX_PLAYERS (8)  ALLOWED_ORIGIN ("*" by default)  LB_FILE (leaderboard save file)
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 8;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TICK_MS = 66; // ~15 updates per second per room
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/* ---------- tiny static file server ---------- */
const httpServer = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  let rel = url === '/' ? '/index.html' : url;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const io = new Server(httpServer, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 20e3,            // tiny messages only
  pingInterval: 10000, pingTimeout: 15000,
});

/* ---------- helpers / validation ---------- */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const rooms = new Map();             // code -> { code, players: Map(id -> player), dirty:Set }
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const slug = (v, max = 16) => (typeof v === 'string' && /^[a-z0-9_]{1,16}$/i.test(v) ? v.slice(0, max) : '');
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const EMOTES = new Set(['👋', '💗', '😂', '⭐', '🎉', '😮', '👍', '🌸']);
const LOOK_STR = /^[#a-zA-Z0-9_-]{1,16}$/;
const LOOK_KEYS = ['sp', 'fur', 'belly', 'scarf', 'hat', 'eyes', 'eyeCol', 'cheek', 'pat', 'patCol', 'outfit', 'outCol', 'acc2', 'accCol', 'hatCol'];
function cleanLook(l) {
  const o = {};
  if (!l || typeof l !== 'object') return o;
  for (const k of LOOK_KEYS) if (typeof l[k] === 'string' && LOOK_STR.test(l[k])) o[k] = l[k];
  if (typeof l.scarfOff === 'boolean') o.scarfOff = l.scarfOff;
  o.size = num(l.size, 0.6, 1.4, 1);
  return o;
}
function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    x: num(s.x, -2000, 2000), y: num(s.y, -5, 120), z: num(s.z, -2000, 2000),
    r: num(s.r, -20, 20),                    // yaw (radians)
    m: num(s.m, 0, 1), a: num(s.a, 0, 2),    // walk amount, air amount
    f: s.f ? 1 : 0,                          // flying
    c: slug(s.c) || 'blossom', s: slug(s.s) || 'w',   // city + scene
  };
}
function newCode() {
  for (let n = 0; n < 200; n++) {
    let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const publicPlayer = p => ({ id: p.id, name: p.name, look: p.look, st: p.st });

function leaveRoom(socket) {
  const code = socket.data.room; if (!code) return;
  socket.leave(code); socket.data.room = null;
  const room = rooms.get(code); if (!room) return;
  room.players.delete(socket.id); room.dirty.delete(socket.id);
  socket.to(code).emit('peer:leave', { id: socket.id });
  if (!room.players.size) rooms.delete(code);
}
function enterRoom(socket, room, name, look, st) {
  const p = { id: socket.id, name, look, st: st || null, lastChat: 0 };
  room.players.set(socket.id, p);
  socket.join(room.code); socket.data.room = room.code;
  socket.to(room.code).emit('peer:join', publicPlayer(p));
  return [...room.players.values()].filter(q => q.id !== socket.id).map(publicPlayer);
}

/* ---------- global leaderboard (kept in memory, saved to ./data/leaderboard.json) ---------- */
const LB_FILE = process.env.LB_FILE || path.join(__dirname, 'data', 'leaderboard.json');
const LB_MAX = { wealth: 1e9, level: 1e7, rats: 1e6, games: 1e7, fish: 1e6, thief: 1e6, badges: 1e3 };  // allowed categories + sanity caps
const LB_KEEP = 500;                                    // entries kept per category
let board = {};                                         // { cat: { uid: { n, sp, v, t } } }
for (const c of Object.keys(LB_MAX)) board[c] = {};
try {
  const saved = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
  for (const c of Object.keys(LB_MAX)) if (saved[c] && typeof saved[c] === 'object') board[c] = saved[c];
  console.log('🏆 Leaderboard loaded from ' + LB_FILE);
} catch (e) { /* first run: nothing saved yet */ }
let lbTimer = null;
function lbSaveSoon() {
  if (lbTimer) return;
  lbTimer = setTimeout(() => {
    lbTimer = null;
    try {
      fs.mkdirSync(path.dirname(LB_FILE), { recursive: true });
      const tmp = LB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(board));
      fs.renameSync(tmp, LB_FILE);
    } catch (e) { console.warn('Could not save leaderboard:', e.message); }
  }, 3000);
}
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 14) || 'Player';
function lbTop(cat, n) {
  return Object.entries(board[cat]).sort((a, b) => b[1].v - a[1].v || a[1].t - b[1].t).slice(0, n);
}
function lbPrune(cat) {
  const all = Object.entries(board[cat]);
  if (all.length <= LB_KEEP) return;
  all.sort((a, b) => b[1].v - a[1].v);
  board[cat] = Object.fromEntries(all.slice(0, LB_KEEP));
}

/* ---------- socket events ---------- */
io.on('connection', socket => {
  socket.data = { room: null, stateAt: 0, joinTries: [] };

  socket.on('room:create', (msg, ack) => {
    if (typeof ack !== 'function') return;
    leaveRoom(socket);
    const code = newCode(); if (!code) return ack({ ok: false, error: 'Server is full, try again later.' });
    const room = { code, players: new Map(), dirty: new Set() }; rooms.set(code, room);
    const peers = enterRoom(socket, room, clean(msg && msg.name, 12) || 'Guest', cleanLook(msg && msg.look), cleanState(msg && msg.st));
    ack({ ok: true, code, id: socket.id, peers, max: MAX_PLAYERS });
  });

  socket.on('room:join', (msg, ack) => {
    if (typeof ack !== 'function') return;
    const now = Date.now(); const t = socket.data.joinTries.filter(x => now - x < 10000); t.push(now); socket.data.joinTries = t;
    if (t.length > 8) return ack({ ok: false, error: 'Too many attempts. Wait a few seconds.' });
    const code = clean(msg && msg.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'No room with that code.' });
    if (socket.data.room === code) return ack({ ok: false, error: 'You are already in this room.' });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'That room is full (' + MAX_PLAYERS + ' players).' });
    leaveRoom(socket);
    const peers = enterRoom(socket, room, clean(msg && msg.name, 12) || 'Guest', cleanLook(msg && msg.look), cleanState(msg && msg.st));
    ack({ ok: true, code, id: socket.id, peers, max: MAX_PLAYERS });
  });

  socket.on('room:leave', () => leaveRoom(socket));

  // position / rotation (volatile: dropping an old packet is fine)
  socket.on('state', st => {
    const code = socket.data.room; if (!code) return;
    const now = Date.now(); if (now - socket.data.stateAt < 25) return; socket.data.stateAt = now; // max ~40/s
    const room = rooms.get(code), p = room && room.players.get(socket.id), s = cleanState(st);
    if (!p || !s) return; p.st = s; room.dirty.add(socket.id);
  });

  socket.on('look', msg => {
    const code = socket.data.room; if (!code) return;
    const room = rooms.get(code), p = room && room.players.get(socket.id); if (!p) return;
    p.look = cleanLook(msg && msg.look); if (msg && msg.name) p.name = clean(msg.name, 12) || p.name;
    socket.to(code).emit('peer:look', { id: p.id, name: p.name, look: p.look });
  });

  socket.on('chat', msg => {
    const code = socket.data.room; if (!code) return;
    const room = rooms.get(code), p = room && room.players.get(socket.id); if (!p) return;
    const now = Date.now(); if (now - p.lastChat < 700) return; p.lastChat = now;
    const text = clean(msg && msg.text, 100); if (!text) return;
    io.to(code).emit('chat', { id: p.id, name: p.name, text });
  });

  socket.on('emote', msg => {
    const code = socket.data.room; if (!code) return;
    const e = msg && msg.e; if (!EMOTES.has(e)) return;
    socket.to(code).emit('emote', { id: socket.id, e });
  });

  /* ----- leaderboard (works without being in a room) ----- */
  socket.on('lb:submit', (msg, ack) => {
    const reply = r => { if (typeof ack === 'function') ack(r); };
    const now = Date.now();
    if (now - (socket.data.lbAt || 0) < 3000) return reply({ ok: false, error: 'Too fast, wait a few seconds.' });
    socket.data.lbAt = now;
    if (!msg || typeof msg !== 'object' || !/^[a-f0-9]{16}$/.test(msg.uid || '') || !msg.vals || typeof msg.vals !== 'object') return reply({ ok: false, error: 'Bad request.' });
    const sp = /^[a-z]{2,12}$/.test(msg.sp || '') ? msg.sp : 'cat';
    const name = cleanName(msg.name);
    for (const cat of Object.keys(LB_MAX)) {
      const v = Math.floor(+msg.vals[cat]);
      if (!Number.isFinite(v) || v < 0 || v > LB_MAX[cat]) continue;
      if (v === 0) { delete board[cat][msg.uid]; continue; }          // no empty rows
      const old = board[cat][msg.uid];
      board[cat][msg.uid] = { n: name, sp, v, t: old ? old.t : now };
      lbPrune(cat);
    }
    lbSaveSoon();
    reply({ ok: true });
  });

  socket.on('lb:get', (msg, ack) => {
    if (typeof ack !== 'function') return;
    const uid = msg && /^[a-f0-9]{16}$/.test(msg.uid || '') ? msg.uid : '';
    const boards = {}, me = {};
    for (const cat of Object.keys(LB_MAX)) {
      const all = lbTop(cat, LB_KEEP);
      boards[cat] = all.slice(0, 20).map(([u, e]) => ({ n: e.n, sp: e.sp, v: e.v, me: u === uid ? 1 : 0 }));
      const i = all.findIndex(([u]) => u === uid);
      if (i >= 0) me[cat] = { rank: i + 1, total: all.length, v: all[i][1].v };
    }
    ack({ ok: true, boards, me });
  });

  socket.on('lb:forget', (msg, ack) => {
    const uid = msg && /^[a-f0-9]{16}$/.test(msg.uid || '') ? msg.uid : '';
    if (uid) { for (const cat of Object.keys(LB_MAX)) delete board[cat][uid]; lbSaveSoon(); }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

/* batched position broadcast: one message per room per tick */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.dirty.size) continue;
    const out = {};
    for (const id of room.dirty) { const p = room.players.get(id); if (p && p.st) out[id] = p.st; }
    room.dirty.clear();
    io.to(room.code).volatile.emit('tick', out);
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log('🌸 Kawaii Village multiplayer server running on port ' + PORT);
  console.log('   Open http://localhost:' + PORT + '  (max ' + MAX_PLAYERS + ' players per room)');
});

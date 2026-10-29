/* =====================================================================
   Kawaii Village 3D - multiplayer server (Node.js + Socket.io)
   - Serves the game from ./public (index.html)
   - Players create / join a ROOM with a 5-letter code
   - Positions (x,y,z), rotation and a few animation flags are relayed ~15x per second
   - Chat + emotes are relayed too. Each player keeps their OWN save game; only presence is shared.

   Run:   npm install && npm start      (then open http://localhost:3000)
   Env:   PORT (3000)  MAX_PLAYERS (8)  ALLOWED_ORIGIN ("*" by default)
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

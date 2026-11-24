const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
  pingInterval: 8000,
  pingTimeout: 6000
});
server.on('connection', s => s.setNoDelay(true));

/* ===== Recursos locales ===== */
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('[aviso] Falta el paquete "qrcode": no habrá código QR. Ejecuta: npm install qrcode'); }
const nm = (...p) => path.join(__dirname, 'node_modules', ...p);
const confettiFile = nm('canvas-confetti', 'dist', 'confetti.browser.js');
if (!fs.existsSync(confettiFile)) console.warn('[aviso] Falta "canvas-confetti": no habrá confeti. Ejecuta: npm install canvas-confetti');

const page = f => (req, res) => res.sendFile(path.join(__dirname, f));
app.disable('x-powered-by');
app.get(['/', '/index.html'], page('index.html'));
app.get(['/mando', '/mando.html'], page('mando.html'));
app.use('/fonts', express.static(nm('@fontsource', 'montserrat', 'files'), { maxAge: '7d' }));
app.get('/vendor/confetti.js', (req, res) => fs.existsSync(confettiFile) ? res.sendFile(confettiFile) : res.status(404).end());

function lanIP() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) return i.address;
  return 'localhost';
}

/* ====== ENLACE AUTOMÁTICO (RENDER O RED LOCAL) ====== */
const joinUrl = req => {
  if (process.env.RENDER_EXTERNAL_URL) {
    return `${process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/mando.html`;
  }
  if (req) {
    return `${req.protocol}://${req.get('host')}/mando.html`;
  }
  return `http://${lanIP()}:${PORT}/mando.html`;
};

app.get('/info', (req, res) => res.json({ url: joinUrl(req) }));

/* ====== GENERACIÓN DEL CÓDIGO QR ====== */
app.get('/qr.svg', (req, res) => {
  if (!QRCode) return res.status(404).end();
  QRCode.toString(joinUrl(req), { type: 'svg', margin: 1, color: { dark: '#46178f', light: '#ffffff' } }, (err, svg) => {
    if (err) return res.status(500).end();
    res.type('image/svg+xml').send(svg);
  });
});

/* ===== Estado ===== */
const players = new Map();
const banned = new Set();
let hostSid = null;
let running = false;
let phase = 'idle';          // idle | question | results
let accepting = false;
let correct = -1;
let answers = {};
let times = {};
let qStart = 0;
let qDur = 20000;
let lastResult = {};
let paused = false, pausedAt = 0, pauseWasAccepting = false;

const online = () => { let n = 0; for (const p of players.values()) if (p.sid) n++; return n; };
const roster = () => [...players.values()].map(p => ({ id: p.id, name: p.name, online: !!p.sid }));
const toHost = (ev, ...args) => { if (hostSid) io.to(hostSid).emit(ev, ...args); };
const pushPlayers = () => toHost('update_players', roster());
const pushCount = () => toHost('answer_update', Object.keys(answers).length, online(), answers);

function ranking() {
  return [...players.values()]
    .sort((a, b) => b.score - a.score || b.ok - a.ok || a.name.localeCompare(b.name))
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, ok: p.ok, ko: p.ko, rank: i + 1 }));
}

function buildPersonal(pid, rank) {
  const idx = rank.findIndex(r => r.id === pid);
  if (idx < 0) return null;
  const me = rank[idx];
  const above = idx > 0 ? rank[idx - 1] : null;
  const below = rank[idx + 1] || null;
  return {
    score: me.score,
    rank: me.rank,
    total: rank.length,
    aboveName: above ? above.name : null,
    gap: above ? above.score - me.score : 0,
    leadOver: !above && below ? me.score - below.score : 0
  };
}

function resetScores() {
  for (const p of players.values()) { p.score = 0; p.ok = 0; p.ko = 0; p.streak = 0; }
}

const remainingMs = () => Math.max(0, qStart + qDur - (paused && pausedAt ? pausedAt : Date.now()));
const liveQuestion = () => phase === 'question' && (accepting || (paused && pauseWasAccepting));

io.on('connection', socket => {
  const isHost = () => socket.id === hostSid;

  /* ---- Host (pantalla principal) ---- */
  socket.on('host_join', fresh => {
    hostSid = socket.id;
    if (fresh) {
      running = false; phase = 'idle'; accepting = false; answers = {}; times = {}; correct = -1; lastResult = {};
      paused = false; pausedAt = 0; pauseWasAccepting = false;
      banned.clear();
      for (const [id, p] of players) if (!p.sid) players.delete(id);
      resetScores();
      io.to('players').emit('resumed', { phase: 'idle', duration: qDur, remaining: 0 });
      io.to('players').emit('wait_for_next');
    }
    pushPlayers();
    if (phase === 'question') pushCount();
  });

  socket.on('start_game', () => {
    if (!isHost()) return;
    running = true; phase = 'idle'; accepting = false; answers = {}; times = {}; lastResult = {};
    paused = false; pausedAt = 0; pauseWasAccepting = false;
    resetScores();
  });

  socket.on('question_ready', secs => {
    if (!isHost()) return;
    secs = Number.isFinite(secs) ? Math.max(5, Math.min(120, secs)) : 20;
    qDur = secs * 1000; qStart = Date.now();
    paused = false; pausedAt = 0; pauseWasAccepting = false;
    answers = {}; times = {}; correct = -1; phase = 'question'; accepting = true;
    io.to('players').emit('show_colors', qDur);
    pushCount();
  });

  socket.on('close_answers', () => {
    if (!isHost() || phase !== 'question') return;
    accepting = false;
    io.to('players').emit('time_up');
  });

  socket.on('pause_game', () => {
    if (!isHost() || paused) return;
    paused = true; pausedAt = Date.now();
    pauseWasAccepting = phase === 'question' && accepting;
    if (pauseWasAccepting) accepting = false;
    io.to('players').emit('paused');
  });

  socket.on('resume_game', () => {
    if (!isHost() || !paused) return;
    if (pauseWasAccepting && phase === 'question') {
      qStart += Date.now() - pausedAt;
      accepting = true;
    }
    paused = false; pausedAt = 0; pauseWasAccepting = false;
    io.to('players').emit('resumed', { phase, duration: qDur, remaining: accepting ? remainingMs() : 0 });
  });

  socket.on('send_results', (c, pts, text, ack) => {
    if (typeof text === 'function') { ack = text; text = ''; }
    const ok = isHost() && phase === 'question';
    let payload = null;
    if (ok) {
      accepting = false; correct = c; phase = 'results';
      pts = Number.isFinite(pts) ? pts : 1;
      text = String(text || '').slice(0, 200);
      const gains = {}, bonuses = {};
      for (const p of players.values()) {
        const r = answers[p.id];
        gains[p.id] = 0; bonuses[p.id] = 0;
        if (r === c) {
          const t = Math.min(times[p.id] ?? qDur, qDur);
          let g = Math.round(pts * 100 * (1 - 0.5 * (t / qDur)));
          p.streak = (p.streak || 0) + 1;
          const bonus = p.streak >= 3 ? Math.min(5, p.streak - 2) * 50 : 0;
          g += bonus;
          p.score += g; p.ok++; gains[p.id] = g; bonuses[p.id] = bonus;
        } else {
          p.streak = 0;
          if (r !== undefined) p.ko++;
        }
      }
      const rank = ranking();
      lastResult = {};
      for (const p of players.values()) {
        lastResult[p.id] = { ...buildPersonal(p.id, rank), gained: gains[p.id], bonus: bonuses[p.id], streak: p.streak, correctText: text };
        if (p.sid) io.to(p.sid).emit('show_results', correct, answers[p.id], lastResult[p.id]);
      }
      const counts = [0, 0, 0, 0];
      for (const v of Object.values(answers)) if (Number.isInteger(v) && v >= 0 && v < 4) counts[v]++;
      const streaks = [...players.values()].filter(p => p.streak >= 3).sort((a, b) => b.streak - a.streak).map(p => ({ name: p.name, streak: p.streak }));
      payload = { answers, ranking: rank, gains, counts, streaks };
    }
    if (typeof ack === 'function') ack(payload);
  });

  socket.on('apply_event', (target, delta, text, ack) => {
    if (!isHost()) return;
    delta = Number.isFinite(delta) ? Math.max(-1000, Math.min(1000, Math.round(delta))) : 0;
    text = String(text || '').slice(0, 140);
    const list = [...players.values()];
    let hit = [];
    if (list.length) {
      const sc = list.map(p => p.score);
      const mx = Math.max(...sc), mn = Math.min(...sc);
      if (target === 'all') hit = list;
      else if (target === 'first' || target === 'last') {
        if (mx === mn && list.length > 1) hit = [list[Math.random() * list.length | 0]];
        else { const m = target === 'first' ? mx : mn; hit = list.filter(p => p.score === m); }
      } else hit = [list[Math.random() * list.length | 0]];
    }
    for (const p of hit) {
      p.score = Math.max(0, p.score + delta);
      if (p.sid) io.to(p.sid).emit('event_hit', { delta, text });
    }
    if (typeof ack === 'function') ack({ ranking: ranking(), affected: hit.map(p => p.name) });
  });

  socket.on('get_ranking', ack => {
    if (isHost() && typeof ack === 'function') ack(ranking());
  });

  socket.on('back_to_waiting', () => {
    if (!isHost()) return;
    phase = 'idle'; accepting = false;
    io.to('players').emit('wait_for_next');
  });

  socket.on('end_game', () => {
    if (!isHost()) return;
    running = false; phase = 'idle'; accepting = false;
    paused = false; pausedAt = 0; pauseWasAccepting = false;
    const rank = ranking();
    io.to('players').emit('resumed', { phase: 'idle', duration: qDur, remaining: 0 });
    for (const p of players.values()) {
      if (p.sid) io.to(p.sid).emit('game_over', buildPersonal(p.id, rank));
    }
  });

  socket.on('kick_player', pid => {
    if (!isHost()) return;
    const p = players.get(String(pid));
    if (!p) return;
    banned.add(p.id);
    clearTimeout(p.timer);
    if (p.sid) {
      io.to(p.sid).emit('kicked');
      const s = io.sockets.sockets.get(p.sid);
      if (s) { s.leave('players'); s.data.pid = null; }
    }
    players.delete(p.id);
    delete answers[p.id]; delete times[p.id]; delete lastResult[p.id];
    pushPlayers();
    if (phase === 'question') pushCount();
  });

  /* ---- Jugadores (celulares) ---- */
  socket.on('join_game', (pid, name) => {
    pid = String(pid || '');
    name = String(name || '').trim().slice(0, 15);
    if (!/^[\w-]{6,40}$/.test(pid) || !name) return;
    if (banned.has(pid)) { socket.emit('kicked'); return; }

    let p = players.get(pid);
    const taken = new Set([...players.values()].filter(x => x.id !== pid).map(x => x.name.toLowerCase()));
    let finalName = name, k = 2;
    while (taken.has(finalName.toLowerCase())) finalName = `${name} ${k++}`;

    if (p) {
      clearTimeout(p.timer);
      p.sid = socket.id;
      p.name = finalName;
    } else {
      p = { id: pid, name: finalName, sid: socket.id, timer: null, score: 0, ok: 0, ko: 0, streak: 0 };
      players.set(pid, p);
    }

    socket.data.pid = pid;
    socket.join('players');
    socket.emit('joined_success', p.name);
    socket.emit('state', {
      phase,
      answered: answers[pid],
      correct: phase === 'results' ? correct : -1,
      personal: phase === 'results' ? (lastResult[pid] || buildPersonal(pid, ranking())) : null,
      duration: qDur,
      remaining: liveQuestion() ? remainingMs() : 0,
      paused
    });
    pushPlayers();
    if (phase === 'question') pushCount();
  });

  socket.on('send_answer', i => {
    const pid = socket.data.pid;
    if (!accepting || paused || !pid || !Number.isInteger(i) || i < 0 || i > 3) return;
    if (Date.now() > qStart + qDur + 1500) return;
    if (Object.hasOwn(answers, pid)) return;
    answers[pid] = i;
    times[pid] = Math.min(Date.now() - qStart, qDur);
    pushCount();
  });

  socket.on('disconnect', () => {
    if (isHost()) { hostSid = null; return; }
    const p = players.get(socket.data.pid);
    if (!p || p.sid !== socket.id) return;
    p.sid = null;
    if (!running) p.timer = setTimeout(() => {
      if (!p.sid && !running) { players.delete(p.id); pushPlayers(); }
    }, 15000);
    pushPlayers();
    if (phase === 'question') pushCount();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor listo.\n  Host:      http://localhost:${PORT}\n  Celulares: ${joinUrl()}`);
});
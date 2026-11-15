import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const game = new Game();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });

wss.on('connection', (ws) => {
  let ctx = null; // { room, player }
  let budget = 40;
  const refill = setInterval(() => { budget = 40; }, 5000);
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const attach = (room, player) => {
    if (ctx) game.disconnect(ctx.room, ctx.player, send);
    ctx = { room, player };
    send({ t: 'joined', code: room.code, token: player.token, id: player.id });
    game.connect(room, player, send);
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      switch (m.t) {
        case 'create': { const r = game.createRoom(m.name, m.flow); if (r.error) return send({ t: 'error', message: r.error }); attach(r.room, r.player); break; }
        case 'join': { const r = game.joinRoom(m.code, m.name); if (r.error) return send({ t: 'error', message: r.error }); attach(r.room, r.player); break; }
        case 'resume': { const r = game.resume(m.code, m.token); if (!r) return send({ t: 'resume-failed' }); attach(r.room, r.player); break; }
        default: {
          if (!ctx) return;
          const { room, player } = ctx;
          if (m.t === 'flow') game.setFlow(room, player, m.flow);
          else if (m.t === 'start') { const r = game.start(room, player); if (r.error) send({ t: 'error', message: r.error }); }
          else if (m.t === 'cmd') { const r = game.runCommand(room, player, m.line); send({ t: 'out', id: m.id, line: String(m.line || ''), out: r.out, code: r.code, action: r.action || null }); }
          else if (m.t === 'save') { const r = game.saveFile(room, player, String(m.path), String(m.content ?? '')); send({ t: 'saved', ...r }); }
          else if (m.t === 'del') game.deleteFile(room, player, String(m.path));
          else if (m.t === 'hint') game.hint(room, player);
          else if (m.t === 'force') game.forceRelease(room, player);
        }
      }
    } catch (e) {
      console.error(e);
      send({ t: 'error', message: 'Server error, please retry.' });
    }
  });
  ws.on('close', () => { clearInterval(refill); if (ctx) game.disconnect(ctx.room, ctx.player, send); });
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000).unref();

server.listen(PORT, () => console.log(`Git Simulation Online → http://localhost:${PORT}`));

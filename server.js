import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(dir, 'public')));
app.get('/tv', (_, res) => res.sendFile(path.join(dir, 'public/tv.html')));
app.get('/join', (_, res) => res.sendFile(path.join(dir, 'public/join.html')));
app.get('/pc', (_, res) => res.sendFile(path.join(dir, 'public/pc.html')));
app.get('/dj', (_, res) => res.sendFile(path.join(dir, 'public/dj.html')));

// ---------- Busca no YouTube (só vídeos que permitem incorporação) ----------
const decode = (s = '') => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: 'YOUTUBE_API_KEY não configurada no servidor.' });

  const params = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '10',
    q: /karaok/i.test(q) ? q : `${q} karaoke`, key,
  });
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await r.json();
    if (!r.ok) {
      const reason = data.error?.errors?.[0]?.reason || 'erro desconhecido';
      console.error('YouTube API:', r.status, reason, data.error?.message);
      return res.status(502).json({ error: `YouTube recusou a busca (${reason}).` });
    }
    const results = (data.items || []).filter(i => i.id?.videoId).map(i => ({
      videoId: i.id.videoId,
      title: decode(i.snippet.title),
      channel: decode(i.snippet.channelTitle),
      thumb: i.snippet.thumbnails?.medium?.url || `https://img.youtube.com/vi/${i.id.videoId}/mqdefault.jpg`,
    }));
    res.json({ results });
  } catch (e) {
    console.error('Falha na busca:', e);
    res.status(502).json({ error: 'Não foi possível falar com o YouTube.' });
  }
});

// ---------- Salas e fila em tempo real ----------
const rooms = new Map(); // roomId -> { queue: [], current: null, playing: false }
const getRoom = id => rooms.get(id) || rooms.set(id, { queue: [], current: null, playing: false, allowControl: true, mode: 'karaoke' }).get(id);
const stateOf = r => ({ queue: r.queue, current: r.current, playing: r.playing, allowControl: r.allowControl, mode: r.mode });
const publish = id => io.to(id).emit('state', stateOf(getRoom(id)));
const advance = id => { const r = getRoom(id); r.current = r.queue.shift() || null; if (!r.current) r.playing = false; publish(id); };

io.on('connection', socket => {
  socket.on('room:join', ({ roomId, name, uid, isHost, hostKey, mode }) => {
    roomId = String(roomId || '').toUpperCase().slice(0, 12);
    if (!roomId) return;
    const r = getRoom(roomId);
    let host = !!isHost;
    if (host && hostKey) {            // sala com dono: só quem tem a chave é o host
      if (!r.hostKey) r.hostKey = String(hostKey).slice(0, 64);
      else if (r.hostKey !== String(hostKey)) host = false;
    } else if (host && r.hostKey) host = false;
    socket.data = { roomId, name: String(name || 'Convidado').slice(0, 20), uid: String(uid || socket.id), isHost: host };
    socket.join(roomId);
    if (host) { r.hostId = socket.id; if (mode === 'dj') r.mode = 'dj'; }
    socket.emit('role', { isHost: host });
    socket.emit('state', stateOf(r));
  });

  socket.on('queue:add', ({ song } = {}) => {
    const { roomId, name, uid } = socket.data || {};
    if (!roomId || !song || !/^[\w-]{11}$/.test(song.videoId || '')) return;
    const r = getRoom(roomId);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      videoId: song.videoId,
      title: String(song.title || 'Karaokê').slice(0, 120),
      channel: String(song.channel || '').slice(0, 80),
      thumb: String(song.thumb || ''),
      singer: name, uid,
    };
    if (!r.current) r.current = item; else r.queue.push(item);
    publish(roomId);
  });

  socket.on('queue:remove', ({ songId } = {}) => {
    const { roomId, uid, isHost } = socket.data || {};
    if (!roomId) return;
    const r = getRoom(roomId);
    r.queue = r.queue.filter(s => !(s.id === songId && (isHost || s.uid === uid))); // convidado remove só a própria; o dono remove qualquer
    publish(roomId);
  });

  // Só a TV avança a fila (fim do vídeo, erro de embed ou botão "Pular")
  socket.on('playback:next', () => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || !isHost) return;
    advance(roomId);
  });

  // Controle remoto: qualquer convidado manda o comando e a TV executa
  socket.on('playback:control', ({ action, value } = {}) => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || !['play', 'pause', 'restart', 'skip', 'volume'].includes(action)) return;
    if (!isHost && !getRoom(roomId).allowControl) return; // o dono pode bloquear o controle dos convidados
    if (action === 'skip') return advance(roomId);
    io.to(roomId).emit('control', { action, value: Number(value) || 0 });
  });

  // O dono liga ou desliga o controle dos convidados
  socket.on('room:settings', ({ allowControl } = {}) => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || !isHost) return;
    getRoom(roomId).allowControl = !!allowControl;
    publish(roomId);
  });

  // A TV informa se o vídeo está tocando ou pausado
  socket.on('playback:status', ({ playing } = {}) => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || !isHost) return;
    getRoom(roomId).playing = !!playing;
    publish(roomId);
  });

  // Reações: emojis dos convidados que sobem pela tela da TV
  socket.on('reaction:send', ({ type } = {}) => {
    const { roomId, name } = socket.data || {};
    if (!roomId || !['clap', 'fire', 'love', 'sing', 'cheers', 'party'].includes(type)) return;
    const now = Date.now();
    if (now - (socket.data.lastReaction || 0) < 250) return; // anti-spam
    socket.data.lastReaction = now;
    const hostId = getRoom(roomId).hostId;
    if (hostId) io.to(hostId).emit('reaction', { type, name });
  });

  // Microfone: o servidor só repassa a negociação WebRTC entre celular e TV (o áudio não passa por aqui)
  socket.on('mic:signal', ({ to, data } = {}) => {
    const { roomId, isHost, name } = socket.data || {};
    if (!roomId || !data) return;
    const r = getRoom(roomId);
    if (isHost) { if (to) io.to(to).emit('mic:signal', { data }); }
    else if (r.hostId) io.to(r.hostId).emit('mic:signal', { from: socket.id, name, data });
  });

  socket.on('mic:stop', () => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || isHost) return;
    const r = getRoom(roomId);
    if (r.hostId) io.to(r.hostId).emit('mic:stop', { from: socket.id });
  });

  socket.on('disconnect', () => {
    const id = socket.data?.roomId;
    const hostId = id && rooms.get(id)?.hostId;
    if (hostId) io.to(hostId).emit('mic:stop', { from: socket.id });
    if (id) setTimeout(() => { if (!io.sockets.adapter.rooms.has(id)) rooms.delete(id); }, 10 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Karaokê no ar: http://localhost:${PORT}/tv`));

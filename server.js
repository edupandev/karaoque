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
const rooms = new Map(); // roomId -> { queue: [], current: null }
const getRoom = id => rooms.get(id) || rooms.set(id, { queue: [], current: null }).get(id);
const publish = id => { const r = getRoom(id); io.to(id).emit('state', { queue: r.queue, current: r.current }); };

io.on('connection', socket => {
  socket.on('room:join', ({ roomId, name, uid, isHost }) => {
    roomId = String(roomId || '').toUpperCase().slice(0, 12);
    if (!roomId) return;
    socket.data = { roomId, name: String(name || 'Convidado').slice(0, 20), uid: String(uid || socket.id), isHost: !!isHost };
    socket.join(roomId);
    const r = getRoom(roomId);
    socket.emit('state', { queue: r.queue, current: r.current });
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
    const { roomId, uid } = socket.data || {};
    if (!roomId) return;
    const r = getRoom(roomId);
    r.queue = r.queue.filter(s => !(s.id === songId && s.uid === uid)); // só remove a própria
    publish(roomId);
  });

  // Só a TV avança a fila (fim do vídeo, erro de embed ou botão "Pular")
  socket.on('playback:next', () => {
    const { roomId, isHost } = socket.data || {};
    if (!roomId || !isHost) return;
    const r = getRoom(roomId);
    r.current = r.queue.shift() || null;
    publish(roomId);
  });

  socket.on('disconnect', () => {
    const id = socket.data?.roomId;
    if (id) setTimeout(() => { if (!io.sockets.adapter.rooms.has(id)) rooms.delete(id); }, 10 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Karaokê no ar: http://localhost:${PORT}/tv`));

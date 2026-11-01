// Comp Check 中継サーバー(依存ゼロ)
// iPhone → iPad のライブ映像(WebRTC)の接続情報だけを受け渡す。映像そのものは通らない。
// tailnet内だけに公開する想定: tailscale serve --bg 8790
//
//   GET  /health                     動作確認
//   GET  /rooms                      送信中の端末一覧 [{ room, name, since }]
//   GET  /rooms/:room/events?peer=ID SSEで受信(送信側は &name=表示名 で部屋を作る)
//   POST /rooms/:room                {from, to?, type, ...} を同じ部屋の他の端末へ(to指定ならその端末だけ)
//
// usage: node server.js [port]
const http = require('http');

const PORT = +process.argv[2] || 8790;
const rooms = new Map(); // room -> { name, since, owner, peers: Map(peerId -> res) }

const send = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
};
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// 端末を部屋から外す。送信側(owner)が抜けたら部屋ごと閉じる
const removePeer = (room, peer) => {
  const r = rooms.get(room);
  if (!r || !r.peers.has(peer)) return;
  const res = r.peers.get(peer);
  r.peers.delete(peer);
  res.end();
  for (const other of r.peers.values()) send(other, { type: 'peer-leave', from: peer });
  if (peer === r.owner || !r.peers.size) {
    for (const other of r.peers.values()) { send(other, { type: 'room-closed' }); other.end(); }
    rooms.delete(room);
    log('room closed', room);
  }
};

// 送信側は20秒ごとに {type:'hb'} を送る。60秒途絶えた部屋(アプリが強制終了された等)は片付ける
const STALE_MS = 60000;
setInterval(() => {
  for (const [room, r] of rooms) if (Date.now() - r.lastSeen > STALE_MS) removePeer(room, r.owner);
}, 10000);

http.createServer((req, res) => {
  cors(res);
  // 接続できないときの切り分け用アクセスログ(ヘルスチェック以外)
  if (!req.url.startsWith('/health')) {
    const ua = req.headers['user-agent'] || '';
    const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Macintosh/.test(ua) ? 'Mac/iPad' : /Windows/.test(ua) ? 'Windows' : ua.slice(0, 20);
    log(req.method, req.url.replace(/name=[^&]*/, 'name=…'), `[${dev}]`, req.headers.origin || '');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/rooms\/([\w-]{4,40})(\/events)?$/);

  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

  if (url.pathname === '/rooms' && req.method === 'GET') {
    // 送信側(owner)が接続中の部屋だけ
    const list = [...rooms.entries()].filter(([, r]) => r.peers.has(r.owner) && Date.now() - r.lastSeen <= STALE_MS)
      .map(([room, r]) => ({ room, name: r.name, since: r.since }));
    return json(res, 200, list);
  }

  if (m && m[2] && req.method === 'GET') {
    const room = m[1], peer = url.searchParams.get('peer') || '', name = url.searchParams.get('name');
    if (!/^[\w-]{4,40}$/.test(peer)) return json(res, 400, { error: 'peer' });
    let r = rooms.get(room);
    if (!r) {
      if (!name) return json(res, 404, { error: 'no such room' });
      r = { name: name.slice(0, 60), since: Date.now(), lastSeen: Date.now(), owner: peer, peers: new Map() };
      rooms.set(room, r);
      log('room open', room, r.name);
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    r.peers.set(peer, res);
    // 他の端末に参加を知らせる(送信側はこれを受けて接続を始める)
    for (const [id, other] of r.peers) if (id !== peer) send(other, { type: 'peer-join', from: peer });
    // プロキシに切られないよう定期的に空行を送る
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    // 切断を検知できた場合はここで外す。プロキシ越しだと届かないことがあるので、
    // アプリからは停止時・ページを閉じる時に {type:'leave'} も送ってもらう
    res.on('close', () => {
      clearInterval(ping);
      if (r.peers.get(peer) === res) removePeer(room, peer);
    });
    return;
  }

  if (m && !m[2] && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'json' }); }
      const r = rooms.get(m[1]);
      if (!r) return json(res, 404, { error: 'no such room' });
      if (msg.type === 'leave') { removePeer(m[1], msg.from); return json(res, 200, { left: true }); }
      if (msg.type === 'hb') { if (msg.from === r.owner) r.lastSeen = Date.now(); return json(res, 200, { ok: true }); }
      let n = 0;
      for (const [id, other] of r.peers) {
        if (id === msg.from || (msg.to && msg.to !== id)) continue;
        send(other, msg); n++;
      }
      json(res, 200, { delivered: n });
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => log(`comp-check signal server on http://127.0.0.1:${PORT}`));

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = 3600;
const rooms = new Map();
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};

function iceServers() {
  const servers = [{ urls: (process.env.STUN_URL || 'stun:stun.l.google.com:19302') }];
  if (TURN_URLS.length && TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + TURN_TTL) + ':remote-demo';
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: TURN_URLS, username, credential });
  }
  return servers;
}
function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function serve(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const root = path.join(__dirname, 'public');
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep) && target !== path.join(root,'index.html')) {
    res.writeHead(403).end(); return;
  }
  if (!['index.html','app.js','style.css'].includes(file)) { res.writeHead(404).end(); return; }
  fs.readFile(target, (err, contents) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'"
    }).end(contents);
  });
}
const server = http.createServer(serve);
const wss = new WebSocketServer({server, path:'/signal', maxPayload:65536, perMessageDeflate:false});
wss.on('connection', (ws, req) => {
  let roomId = null, role = null, count = 0, windowAt = Date.now();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && new URL(origin).host !== host) { ws.close(1008,'bad origin'); return; }
  ws.on('message', raw => {
    if (Date.now() - windowAt > 1000) { count=0; windowAt=Date.now(); }
    if (++count > 100) { ws.close(1008,'rate limit'); return; }
    let m; try { m=JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'join' && !roomId) {
      if (typeof m.room !== 'string' || !/^[a-f0-9]{32}$/.test(m.room) || !['host','viewer'].includes(m.role)) return;
      let room = rooms.get(m.room);
      if (!room) {
        if (m.role !== 'host') { send(ws,{type:'error',message:'Host has not started'}); return; }
        room = {host:null,viewer:null}; rooms.set(m.room,room);
      }
      if (room[m.role]) { send(ws,{type:'error',message:'Role already connected'}); return; }
      roomId=m.room; role=m.role; room[role]=ws;
      send(ws,{type:'joined',iceServers:iceServers()});
      if (room.host && room.viewer) {
        send(room.host,{type:'peer-ready'});
        send(room.viewer,{type:'peer-ready'});
      }
      return;
    }
    if (!roomId || !['offer','answer','candidate','bye'].includes(m.type)) return;
    const peer = rooms.get(roomId)?.[role === 'host' ? 'viewer' : 'host'];
    // SDP/ICE only; no keyboard/mouse events through signalling.
    if (m.type === 'bye') { send(peer,{type:'bye'}); return; }
    if (m.type === 'offer' && role !== 'host') return;
    if (m.type === 'answer' && role !== 'viewer') return;
    if (m.type === 'candidate' && (!m.candidate || typeof m.candidate !== 'object')) return;
    const payload = m.type === 'candidate' ? {type:'candidate',candidate:m.candidate} :
      {type:m.type,description:m.description};
    send(peer,payload);
  });
  ws.on('close', () => {
    if (!roomId) return;
    const room=rooms.get(roomId);
    if (!room || room[role] !== ws) return;
    room[role]=null;
    const peer=room[role === 'host' ? 'viewer' : 'host'];
    send(peer,{type:'bye'});
    if (!room.host && !room.viewer) rooms.delete(roomId);
  });
});
server.listen(PORT,HOST,()=>console.log('Demo: http://' + HOST + ':' + PORT + ' (use HTTPS for remote browsers)'));
process.on('SIGTERM',()=>server.close());

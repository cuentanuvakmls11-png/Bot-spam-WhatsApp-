import express from 'express';
import fs from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const ADMIN_KEY = process.env.ADMIN_KEY || 'cambia-esta-clave';
const PORT = process.env.PORT || 3000;
const DB = 'data.json';
const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : { codes: {} };
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const sessions = {}; // code -> {sock,qr,status}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ---------- WhatsApp ----------
async function start(code) {
  const s = (sessions[code] ||= { status: 'starting', qr: null, sock: null });
  const dir = `sessions/${code}`;
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Panel', 'Chrome', '1.0'] });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { s.qr = qr; s.status = 'qr'; }
    if (connection === 'open') { s.status = 'open'; s.qr = null; }
    if (connection === 'close') {
      const c = lastDisconnect?.error?.output?.statusCode;
      if (c === DisconnectReason.loggedOut) wipe(code);
      else if (valid(code)) setTimeout(() => start(code), 3000);
    }
  });
}
async function wipe(code) {
  const s = sessions[code];
  try { await s?.sock?.logout(); } catch {}
  try { s?.sock?.end?.(); } catch {}
  delete sessions[code];
  fs.rmSync(`sessions/${code}`, { recursive: true, force: true });
}

// ---------- Codigos ----------
function valid(code) {
  const c = db.codes[code];
  if (!c || c.blocked) return false;
  if (c.expiresAt && Date.now() > c.expiresAt) return false;
  return true;
}
// cada minuto: bloquea vencidos y borra su sesion
setInterval(() => {
  for (const [code, c] of Object.entries(db.codes)) {
    if (c.expiresAt && Date.now() > c.expiresAt && !c.blocked) {
      c.blocked = true; save(); wipe(code);
    }
  }
}, 60000);

const admin = (req, res, next) => req.headers['x-admin'] === ADMIN_KEY ? next() : res.status(401).json({ error: 'Clave incorrecta' });
const client = (req, res, next) => {
  const code = req.headers['x-code'];
  if (!valid(code)) return res.status(401).json({ error: 'Acceso vencido o inválido' });
  req.code = code; next();
};

// ---------- Admin ----------
app.post('/api/admin/code', admin, (req, res) => {
  const days = Number(req.body.days) || 5;
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  db.codes[code] = { days, label: req.body.label || '', createdAt: Date.now(), expiresAt: null, blocked: false };
  save(); res.json({ code });
});
app.get('/api/admin/codes', admin, (req, res) => res.json(db.codes));
app.delete('/api/admin/code/:code', admin, async (req, res) => {
  await wipe(req.params.code); delete db.codes[req.params.code]; save(); res.json({ ok: true });
});

// ---------- Cliente ----------
app.post('/api/login', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!valid(code)) return res.status(401).json({ error: 'Código inválido o vencido' });
  const c = db.codes[code];
  if (!c.expiresAt) { c.expiresAt = Date.now() + c.days * 86400000; save(); } // el tiempo corre desde el primer login
  res.json({ code, expiresAt: c.expiresAt });
});

app.get('/api/status', client, async (req, res) => {
  let s = sessions[req.code];
  if (!s) { start(req.code); return res.json({ status: 'starting' }); }
  res.json({ status: s.status, qr: s.qr ? await QRCode.toDataURL(s.qr) : null });
});

app.get('/api/groups', client, async (req, res) => {
  const s = sessions[req.code];
  if (s?.status !== 'open') return res.status(400).json({ error: 'WhatsApp no conectado' });
  const g = await s.sock.groupFetchAllParticipating();
  res.json(Object.values(g).map(x => ({ id: x.id, name: x.subject })));
});

app.post('/api/send', client, (req, res) => {
  const s = sessions[req.code];
  if (s?.status !== 'open') return res.status(400).json({ error: 'WhatsApp no conectado' });
  const { jids = [], text = '', image, phone } = req.body;
  const msg = text + (phone ? `\n\n📲 Contactar: https://wa.me/${String(phone).replace(/\D/g, '')}` : '');
  s.progress = { sent: 0, total: jids.length };
  (async () => {
    for (const jid of jids) {
      if (!valid(req.code)) break;
      try {
        await s.sock.sendMessage(jid, image
          ? { image: Buffer.from(image.split(',')[1], 'base64'), caption: msg }
          : { text: msg });
      } catch (e) { console.log('error envio', e.message); }
      s.progress.sent++;
      await sleep(10000 + Math.random() * 15000); // pausa 10-25 s para reducir baneos
    }
  })();
  res.json({ ok: true, total: jids.length });
});
app.get('/api/progress', client, (req, res) => res.json(sessions[req.code]?.progress || { sent: 0, total: 0 }));

app.listen(PORT, () => console.log('Panel en puerto', PORT));
// reconectar sesiones guardadas al reiniciar
for (const code of Object.keys(db.codes)) if (valid(code) && fs.existsSync(`sessions/${code}`)) start(code);

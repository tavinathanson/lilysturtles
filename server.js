const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const processImage = require('./lib/processImage');
const processDinoImage = require('./lib/processDinoImage');

// Ensure drawings folder exists
const DRAWINGS_DIR = path.join(__dirname, 'drawings');
if (!fs.existsSync(DRAWINGS_DIR)) fs.mkdirSync(DRAWINGS_DIR);

const app = express();

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const EVENT_CODE = config.eventCode || '1234';
const PORT = config.port || 3000;
const MAX_TURTLES = 30;
const MAX_DINOS = 30;
const rateLimitMap = new Map();

let heroTurtle = null;
const turtles = [];
let nextId = 1;

let heroDino = null;
const dinos = [];
let nextDinoId = 1;

const commandQueue = new Map(); // entityId -> { action, timestamp, commandId }
let nextCommandId = 1;
const sseClients = new Set();

// Multer config: memory storage, 5MB limit, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// --- Hero Turtle Generation ---

async function generateHeroTurtle() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="160" viewBox="0 0 200 160">
    <!-- Shell -->
    <ellipse cx="100" cy="80" rx="60" ry="45" fill="#8B9A46"/>
    <ellipse cx="100" cy="75" rx="55" ry="40" fill="#A4B84D"/>
    <ellipse cx="100" cy="72" rx="48" ry="35" fill="#B8CC58"/>
    <!-- Shell pattern -->
    <ellipse cx="100" cy="72" rx="20" ry="15" fill="none" stroke="#8B9A46" stroke-width="2"/>
    <ellipse cx="80" cy="80" rx="12" ry="10" fill="none" stroke="#8B9A46" stroke-width="1.5"/>
    <ellipse cx="120" cy="80" rx="12" ry="10" fill="none" stroke="#8B9A46" stroke-width="1.5"/>
    <ellipse cx="100" cy="92" rx="14" ry="10" fill="none" stroke="#8B9A46" stroke-width="1.5"/>
    <!-- Head -->
    <ellipse cx="168" cy="72" rx="22" ry="18" fill="#7A9A3A"/>
    <ellipse cx="168" cy="70" rx="20" ry="16" fill="#8DB343"/>
    <!-- Eye -->
    <circle cx="178" cy="65" r="5" fill="white"/>
    <circle cx="180" cy="64" r="3" fill="#2D2D2D"/>
    <circle cx="181" cy="63" r="1" fill="white"/>
    <!-- Smile -->
    <path d="M172 76 Q178 82 184 76" fill="none" stroke="#5A7A2A" stroke-width="1.5" stroke-linecap="round"/>
    <!-- Front flipper -->
    <ellipse cx="135" cy="115" rx="22" ry="10" fill="#7A9A3A" transform="rotate(-25 135 115)"/>
    <!-- Back flipper -->
    <ellipse cx="65" cy="112" rx="20" ry="9" fill="#7A9A3A" transform="rotate(20 65 112)"/>
    <!-- Top flipper -->
    <ellipse cx="130" cy="42" rx="18" ry="8" fill="#7A9A3A" transform="rotate(20 130 42)"/>
    <!-- Back top flipper -->
    <ellipse cx="70" cy="45" rx="16" ry="7" fill="#7A9A3A" transform="rotate(-15 70 45)"/>
    <!-- Tail -->
    <path d="M38 82 Q20 85 25 78 Q30 72 40 76" fill="#7A9A3A"/>
    <!-- Golden shimmer -->
    <ellipse cx="100" cy="68" rx="40" ry="25" fill="rgba(201,168,76,0.15)"/>
  </svg>`;

  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(200, 160)
    .png()
    .toBuffer();

  const base64 = pngBuffer.toString('base64');
  heroTurtle = {
    id: 'hero',
    name: (config.turtles && config.turtles.heroName) || "Lily's Turtle",
    imageData: `data:image/png;base64,${base64}`,
    depth: 0.5,
    speed: 30,
    amplitude: 40,
    phase: Math.random() * Math.PI * 2,
    direction: 1,
    isHero: true,
    createdAt: Date.now()
  };
}

// --- Hero Dino Generation ---

async function generateHeroDino() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <!-- Body -->
    <ellipse cx="95" cy="130" rx="45" ry="35" fill="#6B8E23"/>
    <ellipse cx="95" cy="125" rx="42" ry="32" fill="#7A9A2E"/>
    <!-- Tail -->
    <path d="M50 130 Q20 125 10 140 Q5 150 15 148 Q25 140 50 135" fill="#6B8E23"/>
    <!-- Legs -->
    <ellipse cx="75" cy="162" rx="10" ry="15" fill="#5A7A1E"/>
    <ellipse cx="115" cy="162" rx="10" ry="15" fill="#5A7A1E"/>
    <!-- Neck -->
    <path d="M130 115 Q145 90 140 60" fill="#7A9A2E" stroke="#6B8E23" stroke-width="2"/>
    <ellipse cx="135" cy="90" rx="12" ry="30" fill="#7A9A2E"/>
    <!-- Head -->
    <ellipse cx="145" cy="55" rx="28" ry="20" fill="#7A9A2E"/>
    <ellipse cx="145" cy="52" rx="26" ry="18" fill="#8BAA38"/>
    <!-- Eye -->
    <circle cx="155" cy="48" r="6" fill="white"/>
    <circle cx="157" cy="47" r="3.5" fill="#2D2D2D"/>
    <circle cx="158" cy="46" r="1.2" fill="white"/>
    <!-- Jaw -->
    <path d="M160 60 Q170 65 168 58 Q172 62 165 67 Q155 70 150 65" fill="#6B8E23"/>
    <!-- Teeth -->
    <path d="M162 58 L163 62 L164 58 L166 62 L167 59" fill="white" stroke="white" stroke-width="0.5"/>
    <!-- Arms -->
    <path d="M125 120 Q135 112 132 105" fill="none" stroke="#6B8E23" stroke-width="4" stroke-linecap="round"/>
    <path d="M132 105 L130 102 M132 105 L135 103" fill="none" stroke="#5A7A1E" stroke-width="2" stroke-linecap="round"/>
    <!-- Back texture -->
    <path d="M60 115 Q70 108 80 112 Q90 106 100 110 Q110 104 120 112" fill="none" stroke="#5A7A1E" stroke-width="2"/>
    <!-- Earthy shimmer -->
    <ellipse cx="95" cy="125" rx="30" ry="20" fill="rgba(180,160,80,0.15)"/>
  </svg>`;

  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(200, 200)
    .png()
    .toBuffer();

  const base64 = pngBuffer.toString('base64');
  heroDino = {
    id: 'hero-dino',
    name: (config.dinos && config.dinos.heroName) || "Ari's Dinosaur",
    imageData: `data:image/png;base64,${base64}`,
    species: 'trex',
    depth: 0.5,
    speed: 30,
    amplitude: 40,
    phase: Math.random() * Math.PI * 2,
    direction: 1,
    isHero: true,
    createdAt: Date.now()
  };
}

// --- Rate Limiting ---

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 60000 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= 20;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// --- Routes ---

app.get('/', (req, res) => {
  res.redirect('/live');
});

app.get('/live', (req, res) => {
  res.redirect('/live-turtles');
});

app.get('/live-turtles', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live-turtles.html'));
});

app.get('/upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload.html'));
});

app.get('/flyer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'flyer.html'));
});

app.get('/coloring', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'coloring.html'));
});

app.get('/live-dinos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'live-dinos.html'));
});

app.get('/upload-dinos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'upload-dinos.html'));
});

app.get('/coloring-dinos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'coloring-dinos.html'));
});

app.get('/reset', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.json());

// Config endpoint — returns title/heroName for a given mode
app.get('/api/config', (req, res) => {
  const mode = req.query.mode || 'turtles';
  const modeConfig = config[mode] || config.turtles || {};
  res.json({ title: modeConfig.title, heroName: modeConfig.heroName });
});

// Serve saved drawings as static files
app.use('/drawings', express.static(DRAWINGS_DIR));

// Gallery page — shows all uploaded drawings
app.get('/gallery', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(DRAWINGS_DIR)
      .filter(f => f.endsWith('.png'))
      .sort((a, b) => {
        const idA = parseInt(a.split('_')[0]) || 0;
        const idB = parseInt(b.split('_')[0]) || 0;
        return idB - idA; // newest first
      });
  } catch {}

  const cards = files.map(f => {
    const name = f.replace(/^\d+_/, '').replace(/\.png$/, '').replace(/_/g, ' ');
    return `<div class="card"><img src="/drawings/${f}" alt="${name}"><div class="name">${name}</div></div>`;
  }).join('\n');

  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turtle Drawings</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#041526;color:white;font-family:'Nunito',sans-serif;padding:24px}
  h1{text-align:center;font-size:32px;margin-bottom:24px}
  .count{text-align:center;color:#88b8d0;margin-bottom:24px;font-size:15px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px;max-width:1200px;margin:0 auto}
  .card{background:rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;text-align:center}
  .card img{width:100%;aspect-ratio:1;object-fit:contain;background:white;padding:8px}
  .name{padding:10px;font-weight:700;font-size:15px}
  .empty{text-align:center;color:#88b8d0;margin-top:60px;font-size:18px}
  a.back{display:block;text-align:center;color:#14a3c7;margin-bottom:20px;font-size:15px}
</style>
</head><body>
<h1>Turtle Drawings</h1>
<a class="back" href="/live">Back to aquarium</a>
<div class="count">${files.length} drawing${files.length !== 1 ? 's' : ''}</div>
${files.length ? `<div class="grid">${cards}</div>` : '<div class="empty">No drawings yet. Upload some turtles!</div>'}
</body></html>`);
});

// SSE endpoint for instant command delivery to live clients
app.get('/api/events', (req, res) => {
  const { eventCode } = req.query;
  if (eventCode !== EVENT_CODE) {
    return res.status(403).json({ error: 'Wrong event code.' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// SSE heartbeat to keep connections alive
setInterval(() => {
  for (const client of sseClients) {
    client.write(': heartbeat\n\n');
  }
}, 20000);

app.post('/api/turtle/:id/command', (req, res) => {
  const { action, eventCode } = req.body;
  if (eventCode !== EVENT_CODE) {
    return res.status(403).json({ error: 'Wrong event code.' });
  }
  const validActions = ['come_closer', 'birthday_cake', 'spin', 'party_hat'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid action.' });
  }
  const id = req.params.id;
  const exists = turtles.some(t => t.id === id) || (heroTurtle && heroTurtle.id === id)
    || dinos.some(d => d.id === id) || (heroDino && heroDino.id === id);
  if (!exists) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const commandId = `cmd_${nextCommandId++}`;
  commandQueue.set(id, { action, timestamp: Date.now(), commandId });

  // Push to all SSE clients immediately
  const sseData = JSON.stringify({ turtleId: id, command: action, commandId });
  for (const client of sseClients) {
    client.write(`data: ${sseData}\n\n`);
  }

  res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
  const { eventCode } = req.body;
  if (eventCode !== EVENT_CODE) {
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return res.status(403).json({ error: 'Wrong event code.' });
  }
  turtles.length = 0;
  nextId = 1;
  commandQueue.clear();
  res.json({ success: true });
});

app.post('/api/delete-turtles', (req, res) => {
  const { eventCode, ids } = req.body;
  if (eventCode !== EVENT_CODE) {
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return res.status(403).json({ error: 'Wrong event code.' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No turtle IDs provided.' });
  }
  const toDelete = new Set(ids.map(String).filter(id => id !== 'hero'));
  let deleted = 0;
  for (let i = turtles.length - 1; i >= 0; i--) {
    if (toDelete.has(turtles[i].id)) {
      turtles.splice(i, 1);
      deleted++;
    }
  }
  // Broadcast delete event via SSE
  if (deleted > 0) {
    const sseData = JSON.stringify({ deleted: Array.from(toDelete) });
    for (const client of sseClients) {
      client.write(`event: delete\ndata: ${sseData}\n\n`);
    }
  }
  res.json({ success: true, deleted });
});

app.post('/api/delete-dinos', (req, res) => {
  const { eventCode, ids } = req.body;
  if (eventCode !== EVENT_CODE) {
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return res.status(403).json({ error: 'Wrong event code.' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No dino IDs provided.' });
  }
  const toDelete = new Set(ids.map(String).filter(id => id !== 'hero-dino'));
  let deleted = 0;
  for (let i = dinos.length - 1; i >= 0; i--) {
    if (toDelete.has(dinos[i].id)) {
      dinos.splice(i, 1);
      deleted++;
    }
  }
  if (deleted > 0) {
    const sseData = JSON.stringify({ deleted: Array.from(toDelete) });
    for (const client of sseClients) {
      client.write(`event: delete\ndata: ${sseData}\n\n`);
    }
  }
  res.json({ success: true, deleted });
});

app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    const { eventCode, name } = req.body;

    if (eventCode !== EVENT_CODE) {
      const ip = req.ip;
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      }
      return res.status(403).json({ error: 'Wrong event code.' });
    }

    const mode = req.body.mode || 'turtle';

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    if (name.trim().length > 30) {
      return res.status(400).json({ error: 'Name must be 30 characters or less.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Photo is required.' });
    }

    if (mode === 'dino') {
      // --- Dino upload ---
      const result = await processDinoImage(req.file.buffer);

      const dino = {
        id: 'd' + String(nextDinoId++),
        name: name.trim(),
        imageData: result.imageData,
        species: result.species,
        depth: 0.1 + Math.random() * 0.8,
        speed: 40 + Math.random() * 60,
        amplitude: 15 + Math.random() * 35,
        phase: Math.random() * Math.PI * 2,
        direction: Math.random() < 0.5 ? -1 : 1,
        createdAt: Date.now()
      };

      dinos.push(dino);

      // Save drawing to disk
      try {
        const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
        const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = path.join(DRAWINGS_DIR, `dino_${dino.id}_${safeName}.png`);
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      } catch (e) {
        console.error('Failed to save dino drawing:', e);
      }

      // FIFO eviction
      while (dinos.length > MAX_DINOS) {
        dinos.shift();
      }

      const response = { success: true, id: dino.id, name: dino.name, species: result.species };
      if (result.hint) response.hint = result.hint;
      res.json(response);
    } else {
      // --- Turtle upload (default) ---
      const result = await processImage(req.file.buffer);

      const turtle = {
        id: String(nextId++),
        name: name.trim(),
        imageData: result.imageData,
        depth: 0.1 + Math.random() * 0.8,
        speed: 40 + Math.random() * 60,
        amplitude: 15 + Math.random() * 35,
        phase: Math.random() * Math.PI * 2,
        direction: Math.random() < 0.5 ? -1 : 1,
        createdAt: Date.now()
      };

      turtles.push(turtle);

      // Save drawing to disk
      try {
        const base64 = result.imageData.replace(/^data:image\/\w+;base64,/, '');
        const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
        const filePath = path.join(DRAWINGS_DIR, `${turtle.id}_${safeName}.png`);
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      } catch (e) {
        console.error('Failed to save drawing:', e);
      }

      // FIFO eviction
      while (turtles.length > MAX_TURTLES) {
        turtles.shift();
      }

      const response = { success: true, id: turtle.id, name: turtle.name };
      if (result.hint) response.hint = result.hint;
      res.json(response);
    }
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process image.' });
  }
});

app.get('/api/turtles', (req, res) => {
  const { eventCode, knownIds } = req.query;

  if (eventCode !== EVENT_CODE) {
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return res.status(403).json({ error: 'Wrong event code.' });
  }

  const knownSet = new Set(knownIds ? knownIds.split(',') : []);

  const allTurtles = heroTurtle ? [heroTurtle, ...turtles] : [...turtles];

  const result = allTurtles.map(t => {
    let entry;
    if (knownSet.has(t.id)) {
      // Client already has the image, omit imageData
      const { imageData, ...rest } = t;
      entry = rest;
    } else {
      entry = { ...t };
    }
    // Attach pending command (one-shot: deliver then clear)
    if (commandQueue.has(t.id)) {
      const cmd = commandQueue.get(t.id);
      entry.command = cmd.action;
      entry.commandId = cmd.commandId;
      commandQueue.delete(t.id);
    }
    return entry;
  });

  res.json({ turtles: result });
});

app.get('/api/dinos', (req, res) => {
  const { eventCode, knownIds } = req.query;

  if (eventCode !== EVENT_CODE) {
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    return res.status(403).json({ error: 'Wrong event code.' });
  }

  const knownSet = new Set(knownIds ? knownIds.split(',') : []);

  const allDinos = heroDino ? [heroDino, ...dinos] : [...dinos];

  const result = allDinos.map(d => {
    let entry;
    if (knownSet.has(d.id)) {
      const { imageData, ...rest } = d;
      entry = rest;
    } else {
      entry = { ...d };
    }
    if (commandQueue.has(d.id)) {
      const cmd = commandQueue.get(d.id);
      entry.command = cmd.action;
      entry.commandId = cmd.commandId;
      commandQueue.delete(d.id);
    }
    return entry;
  });

  res.json({ dinos: result });
});

// Error handler for multer file size errors
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
  }
  if (err.message === 'Only image files are allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// --- Start ---

Promise.all([generateHeroTurtle(), generateHeroDino()]).then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Event code: ${EVENT_CODE}`);
  });
}).catch(err => {
  console.error('Failed to generate heroes:', err);
  process.exit(1);
});

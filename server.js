const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const USEAPI_TOKEN = process.env.USEAPI_TOKEN;
const RUNWAY_EMAIL = process.env.RUNWAY_EMAIL || '';
const USEAPI_BASE = 'https://api.useapi.net/v1/runwayml';

const withEmail = (qs = {}) => {
  const params = new URLSearchParams(qs);
  if (RUNWAY_EMAIL) params.set('email', RUNWAY_EMAIL);
  const s = params.toString();
  return s ? `?${s}` : '';
};

if (!USEAPI_TOKEN) {
  console.warn('[warn] USEAPI_TOKEN is not set. Set it in your environment before generating videos.');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const authHeader = () => ({ Authorization: `Bearer ${USEAPI_TOKEN}` });

async function uploadAsset(buffer, mimetype, name) {
  const url = `${USEAPI_BASE}/assets/${withEmail({ name })}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': mimetype },
    body: buffer,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?.message || text || `Asset upload failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json;
}

async function createSeedanceVideo({ assetId, prompt }) {
  const body = {
    model: 'seedance-2',
    text_prompt: prompt,
    duration: 15,
    aspect_ratio: '16:9',
    resolution: '720p',
    audio: true,
    imageAssetId1: assetId,
  };
  if (RUNWAY_EMAIL) body.email = RUNWAY_EMAIL;
  const res = await fetch(`${USEAPI_BASE}/videos/create`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?.message || text || `Video create failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json;
}

async function getTask(taskId) {
  const url = `${USEAPI_BASE}/tasks/${withEmail({ taskId })}`;
  const res = await fetch(url, { headers: { ...authHeader() } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?.message || text || `Task fetch failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json;
}

function extractTask(payload) {
  if (!payload) return null;
  if (payload.task) return payload.task;
  if (Array.isArray(payload.tasks) && payload.tasks.length) return payload.tasks[0];
  if (payload.taskId || payload.status) return payload;
  return null;
}

function extractVideoUrl(task) {
  if (!task) return null;
  const arts = task.artifacts || [];
  for (const a of arts) {
    if (a?.url) return a.url;
    if (Array.isArray(a?.imageVersions) && a.imageVersions[0]?.url) return a.imageVersions[0].url;
  }
  return null;
}

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'Server missing USEAPI_TOKEN.' });
    if (!req.file) return res.status(400).json({ error: 'Reference image is required.' });
    const prompt = (req.body.prompt || '').toString().trim();
    if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

    const assetName = `ref-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const asset = await uploadAsset(req.file.buffer, req.file.mimetype || 'image/png', assetName);
    const assetId = asset.assetId || asset.id;
    if (!assetId) return res.status(502).json({ error: 'Asset upload returned no assetId.', detail: asset });

    const created = await createSeedanceVideo({ assetId, prompt });
    const task = extractTask(created);
    const taskId = task?.taskId || task?.id;
    if (!taskId) return res.status(502).json({ error: 'Video create returned no taskId.', detail: created });

    res.json({ taskId, status: task?.status || 'PENDING', prompt });
  } catch (err) {
    console.error('[generate]', err);
    res.status(500).json({ error: err.message || 'Generate failed.' });
  }
});

app.get('/api/status/:taskId', async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'Server missing USEAPI_TOKEN.' });
    const payload = await getTask(req.params.taskId);
    const task = extractTask(payload) || {};
    const status = task.status || 'PENDING';
    const videoUrl = status === 'SUCCEEDED' ? extractVideoUrl(task) : null;
    res.json({
      taskId: task.taskId || req.params.taskId,
      status,
      progressRatio: task.progressRatio ?? null,
      progressText: task.progressText ?? null,
      error: task.error || null,
      videoUrl,
    });
  } catch (err) {
    console.error('[status]', err);
    res.status(500).json({ error: err.message || 'Status fetch failed.' });
  }
});

app.get('/api/download/:taskId', async (req, res) => {
  try {
    const payload = await getTask(req.params.taskId);
    const task = extractTask(payload);
    const url = extractVideoUrl(task);
    if (!url) return res.status(404).json({ error: 'Video not ready.' });

    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: `Upstream fetch failed (${upstream.status}).` });
    }
    const filename = `seedance-${req.params.taskId.replace(/[^a-z0-9_-]/gi, '_')}.mp4`;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    };
    await pump();
  } catch (err) {
    console.error('[download]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Download failed.' });
    else res.end();
  }
});

app.post('/api/download-bulk', async (req, res) => {
  try {
    const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    if (!taskIds.length) return res.status(400).json({ error: 'taskIds required.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="seedance-videos-${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (e) => { console.error('[zip]', e); try { res.end(); } catch {} });
    archive.pipe(res);

    for (const taskId of taskIds) {
      try {
        const payload = await getTask(taskId);
        const task = extractTask(payload);
        const url = extractVideoUrl(task);
        if (!url) continue;
        const upstream = await fetch(url);
        if (!upstream.ok || !upstream.body) continue;
        const buf = Buffer.from(await upstream.arrayBuffer());
        const safe = String(taskId).replace(/[^a-z0-9_-]/gi, '_');
        archive.append(buf, { name: `seedance-${safe}.mp4` });
      } catch (e) {
        console.error('[zip-item]', taskId, e.message);
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('[bulk]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Bulk download failed.' });
    else res.end();
  }
});

app.get('/api/accounts', async (_req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'Server missing USEAPI_TOKEN.' });
    const r = await fetch(`${USEAPI_BASE}/accounts/`, { headers: { ...authHeader() } });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) return res.status(r.status).json(json);
    const emails = json && typeof json === 'object' ? Object.keys(json) : [];
    res.json({ count: emails.length, emails, pinnedEmail: RUNWAY_EMAIL || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, runwayEmailPinned: !!RUNWAY_EMAIL }));

app.listen(PORT, () => {
  console.log(`Seedance Video Studio listening on :${PORT}`);
});

// ==============================================================================
// BACKEND PROXY: STREAMING SERVICE
// ==============================================================================
// Bypasses browser memory limits for multi-gigabyte repositories.
// O(1) memory footprint during stream.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const unzipper = require('unzipper');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS: explicit allowlist, no open wildcard default ---
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server (no origin) or explicitly listed origins only
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  }
}));

app.use(express.json());

// --- PROXY SHARED SECRET: optional second layer against abuse ---
const PROXY_SECRET = process.env.PROXY_SECRET || null;

const EXCLUDED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp',
  'mp4', 'webm', 'ogg', 'mp3', 'wav',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'zip', 'tar', 'gz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm'
]);

// --- SHARED SECRET MIDDLEWARE ---
function checkProxySecret(req, res, next) {
  if (!PROXY_SECRET) return next(); // not configured = open (log warning at boot)
  const provided = req.headers['x-proxy-secret'];
  // Constant-time compare to prevent timing attacks
  const valid =
    provided &&
    provided.length === PROXY_SECRET.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(PROXY_SECRET));
  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

app.get('/api/health', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ state: 'operational', timestamp: new Date().toISOString() }));
});

app.post('/api/pack/:owner/:repo', checkProxySecret, async (req, res) => {
  const { owner, repo } = req.params;

  // --- TOKEN: from POST body only, never query string ---
  const clientToken = req.body?.token || null;
  const token = clientToken || process.env.GITHUB_PAT;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/zipball`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Repo-Pack-Main-Backend'
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  // --- REQUEST TIMEOUT: 30s connect, 120s total download ---
  const controller = new AbortController();
  const connectTimeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await axios({
      method: 'get',
      url: apiUrl,
      responseType: 'stream',
      headers,
      maxRedirects: 5,
      timeout: 120000,
      signal: controller.signal
    });

    clearTimeout(connectTimeout);

    res.setHeader('Content-Disposition', `attachment; filename="${owner}_${repo}_pack.txt"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    res.write(`=================================================================\n`);
    res.write(`Repository: ${owner}/${repo}\n`);
    res.write(`Generated: ${new Date().toISOString()}\n`);
    res.write(`Engine: Server-Side Streaming (JS)\n`);
    res.write(`=================================================================\n\n`);

    let fileCount = 0;
    let skippedCount = 0;

    const zipStream = response.data.pipe(unzipper.Parse({ forceStream: true }));

    // --- BACKPRESSURE: pause zip stream when response buffer is full ---
    zipStream.on('entry', (entry) => {
      const fileName = entry.path;
      const type = entry.type;

      if (type === 'Directory') {
        entry.autodrain();
        return;
      }

      const pathParts = fileName.split('/');
      pathParts.shift();
      const relativePath = pathParts.join('/');

      if (!relativePath) {
        entry.autodrain();
        return;
      }

      const extension = path.extname(relativePath).slice(1).toLowerCase();

      if (EXCLUDED_EXTENSIONS.has(extension) || entry.vars.uncompressedSize > 2000000) {
        skippedCount++;
        entry.autodrain();
        return;
      }

      res.write(`\n\n--- FILE: ${relativePath} ---\n\n`);

      // Pipe with backpressure: pause zip if response buffer is full
      const canContinue = entry.pipe(res, { end: false });

      if (!canContinue) {
        zipStream.pause();
        res.once('drain', () => zipStream.resume());
      }

      entry.on('end', () => fileCount++);

      entry.on('error', (err) => {
        console.error(`[STREAM ERROR] File: ${relativePath}`, err);
        res.write(`\n[ERROR READING FILE: ${err.message}]\n`);
        skippedCount++;
      });
    });

    zipStream.on('close', () => {
      res.write(`\n\n=================================================================\n`);
      res.write(`SUMMARY: ${fileCount} files packed. ${skippedCount} items bypassed.\n`);
      res.write(`=================================================================\n`);
      res.end();
    });

    zipStream.on('error', (err) => {
      console.error('[ZIP PARSE ERROR]', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse repository bundle.' }));
      } else {
        res.end(`\n\n[FATAL ERROR: ZIP PARSING FAILED]`);
      }
    });

  } catch (error) {
    clearTimeout(connectTimeout);
    console.error('[FETCH ERROR]', error.message);

    if (!res.headersSent) {
      let code = 500;
      let message = 'Failed to fetch repository. Verify it is public and the URL is correct.';

      const errStr = String(error.message);
      if (error.name === 'AbortError' || errStr.includes('aborted')) {
        code = 504;
        message = 'GitHub connection timed out. Try again.';
      } else if (errStr.includes('403')) {
        code = 403;
        message = 'GitHub API limit exceeded. Provide a PAT in settings.';
      } else if (errStr.includes('404')) {
        code = 404;
        message = 'Repository not found. Check spelling or visibility.';
      }

      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message, details: error.message }));
    } else {
      res.end(`\n\n[FATAL ERROR: UPSTREAM CONNECTION LOST]`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[MAIN] Streaming Backend active on port ${PORT}`);
  if (!process.env.GITHUB_PAT) {
    console.warn(`[WARN] GITHUB_PAT missing. Global 60 req/hr unauthenticated limit applies.`);
  }
  if (!process.env.ALLOWED_ORIGINS) {
    console.warn(`[WARN] ALLOWED_ORIGINS not set. All cross-origin requests are BLOCKED. Set this in Railway env vars.`);
  }
  if (!PROXY_SECRET) {
    console.warn(`[WARN] PROXY_SECRET not set. Proxy endpoint is unauthenticated.`);
  }
});

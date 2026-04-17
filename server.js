// ==============================================================================
// BACKEND PROXY: STREAMING ARCHITECTURE
// ==============================================================================
// ASSUMPTION: Running a Node.js proxy is acceptable to bypass browser memory
// limits for multi-gigabyte repositories. O(1) memory footprint during stream.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const unzipper = require('unzipper');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Middlewares
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*';
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Excluded extensions exactly matching the client logic to maintain integrity.
const EXCLUDED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'webp', 
  'mp4', 'webm', 'ogg', 'mp3', 'wav', 
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'zip', 'tar', 'gz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'wasm'
]);

/**
 * Health Check Endpoint
 */
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'operational', timestamp: new Date().toISOString() });
});

/**
 * Core Streaming Endpoint
 * Streams a zip from GitHub, unzips on the fly, filters, and pipes formatted text back to the client.
 */
app.get('/api/pack/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params;
  const clientToken = req.query.token;
  
  // Prioritize request token over environment token.
  const token = clientToken || process.env.GITHUB_PAT;
  
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/zipball`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Repo-Pack-Core-Backend'
  };

  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  try {
    // 1. Initiate stream from GitHub
    const response = await axios({
      method: 'get',
      url: apiUrl,
      responseType: 'stream',
      headers,
      maxRedirects: 5
    });

    // 2. Set response headers for the client download
    res.setHeader('Content-Disposition', `attachment; filename="${owner}_${repo}_pack.txt"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    // Write header block
    res.write(`=================================================================\n`);
    res.write(`Repository: ${owner}/${repo}\n`);
    res.write(`Generated: ${new Date().toISOString()}\n`);
    res.write(`Engine: Server-Side Streaming (Node.js)\n`);
    res.write(`=================================================================\n\n`);

    let fileCount = 0;
    let skippedCount = 0;

    // 3. Pipe GitHub zip stream directly into the Unzipper parser
    const zipStream = response.data.pipe(unzipper.Parse({ forceStream: true }));

    zipStream.on('entry', async (entry) => {
      const fileName = entry.path;
      const type = entry.type; // 'Directory' or 'File'
      
      if (type === 'Directory') {
        entry.autodrain();
        return;
      }

      // Format path (GitHub prepends a root directory with the commit hash)
      const pathParts = fileName.split('/');
      pathParts.shift(); 
      const relativePath = pathParts.join('/');

      if (!relativePath) {
        entry.autodrain();
        return;
      }

      const extension = path.extname(relativePath).slice(1).toLowerCase();

      // ASSUMPTION: 2MB limit per file is enforced on the backend to prevent hanging on minified bundles
      if (EXCLUDED_EXTENSIONS.has(extension) || entry.vars.uncompressedSize > 2000000) {
        skippedCount++;
        entry.autodrain();
        return;
      }

      try {
        res.write(`\n\n--- FILE: ${relativePath} ---\n\n`);
        
        // Pipe the uncompressed file stream directly into the response stream
        entry.on('data', (chunk) => {
          res.write(chunk);
        });

        entry.on('end', () => {
          fileCount++;
        });

        entry.on('error', (err) => {
          console.error(`[STREAM ERROR] File: ${relativePath}`, err);
          res.write(`\n[ERROR READING FILE: ${err.message}]\n`);
          skippedCount++;
        });

      } catch (err) {
        skippedCount++;
        entry.autodrain();
      }
    });

    zipStream.on('close', () => {
      res.write(`\n\n=================================================================\n`);
      res.write(`SUMMARY: ${fileCount} files packed. ${skippedCount} items skipped/excluded.\n`);
      res.write(`=================================================================\n`);
      res.end();
    });

    zipStream.on('error', (err) => {
      console.error('[ZIP PARSE ERROR]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to parse repository archive.' });
      } else {
        res.end(`\n\n[FATAL ERROR: ZIP PARSING FAILED]`);
      }
    });

  } catch (error) {
    console.error('[FETCH ERROR]', error.message);
    if (!res.headersSent) {
      const status = error.response ? error.response.status : 500;
      let message = 'Failed to fetch repository. Ensure it is public and the URL is correct.';
      if (status === 403) message = 'GitHub API rate limit exceeded. Provide a PAT in settings.';
      if (status === 404) message = 'Repository not found. Check spelling or visibility.';
      
      res.status(status).json({ error: message, details: error.message });
    } else {
      res.end(`\n\n[FATAL ERROR: UPSTREAM CONNECTION LOST]`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`[CORE] Streaming Backend active on port ${PORT}`);
  if (!process.env.GITHUB_PAT) {
    console.warn(`[WARN] GITHUB_PAT is missing. Global 60 req/hr unauthenticated limit applies.`);
  }
});

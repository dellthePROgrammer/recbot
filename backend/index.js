import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import crypto from 'crypto';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 4100;

// Directory to scan for .wav files (can be mounted in Docker)
const WAV_DIR = '/data/wav/recordings';
const CACHE_DIR = '/data/wav/cache';

app.use(cors());

function getWavFilesFast(rootDir) {
  return new Promise((resolve, reject) => {
    const files = [];
    const proc = spawn('./list_files', [rootDir]);
    let leftover = '';

    proc.stdout.on('data', (data) => {
      const lines = (leftover + data.toString()).split('\n');
      leftover = lines.pop();
      files.push(...lines.filter(Boolean));
    });

    proc.stdout.on('end', () => {
      if (leftover) files.push(leftover);
      resolve(files);
    });

    proc.stderr.on('data', (data) => {
      console.error('C++ scanner error:', data.toString());
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`Scanner exited with code ${code}`));
    });
  });
}

// Stream a .wav file (support subdirectory path, with Range support)
app.get('/api/wav-files/*', (req, res) => {
  const relPath = decodeURIComponent(req.params[0]);
  const filePath = path.join(WAV_DIR, relPath);

  const resolvedBase = path.resolve(WAV_DIR);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedBase)) {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  // Ensure cache directory exists
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = getCachePath(resolvedFile);

  // Helper to stream a file with Range support
  function streamWithRangeSupport(fileToServe, stats) {
    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolvedFile)}"`);
      return fs.createReadStream(fileToServe).pipe(res);
    }
    // Parse Range header
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stats.size - 1;
    const chunkSize = (end - start) + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolvedFile)}"`);

    fs.createReadStream(fileToServe, { start, end }).pipe(res);
  }

  // If cached PCM exists, serve it with Range support
  if (fs.existsSync(cachePath)) {
    fs.stat(cachePath, (err, stats) => {
      if (err || !stats.isFile()) {
        return res.status(404).json({ error: 'File not found' });
      }
      streamWithRangeSupport(cachePath, stats);
    });
    return;
  }

  // Otherwise, transcode and cache, then stream after caching (with Range support)
  const ffmpeg = spawn('ffmpeg', [
    '-i', resolvedFile,
    '-f', 'wav',
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '8000',
    cachePath
  ]);

  ffmpeg.stderr.on('data', (data) => {
    console.error(`ffmpeg stderr: ${data}`);
  });

  ffmpeg.on('error', (error) => {
    console.error('ffmpeg error:', error);
    res.status(500).end();
  });

  ffmpeg.on('close', (code) => {
    if (code !== 0) {
      console.error(`ffmpeg exited with code ${code}`);
      return res.status(500).end();
    }
    // Now stream the cached file with Range support
    fs.stat(cachePath, (err, stats) => {
      if (err || !stats.isFile()) {
        return res.status(404).json({ error: 'File not found' });
      }
      streamWithRangeSupport(cachePath, stats);
    });
  });
});

app.get('/api/wav-files', async (req, res) => {
  try {
    const files = await getWavFilesFast(WAV_DIR);
    res.json(files);
  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json([]);
  }
});

function getCachePath(originalPath) {
  // Use a hash of the original path for unique cache file names
  const hash = crypto.createHash('md5').update(originalPath).digest('hex');
  return path.join(CACHE_DIR, hash + '.wav');
}

// Serve React static files
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
app.use(express.static(BUILD_DIR));

// Fallback: serve index.html for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(BUILD_DIR, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});

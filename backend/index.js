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
const PORT = process.env.PORT || 4000;

// Directory to scan for .wav files (can be mounted in Docker)
const WAV_DIR = '/data/wav/recordings';
const CACHE_DIR = '/data/wav/cache';

app.use(cors());

app.get('/api/wav-files', (req, res) => {
  try {
    const { dateStart, dateEnd, page = 1, pageSize = 100, phone, email, duration, durationMode = "min" } = req.query;
    let foldersToScan = [];

    if (dateStart && dateEnd) {
      // Range: collect all date folders in the range
      const start = dayjs(dateStart, "M_D_YYYY");
      const end = dayjs(dateEnd, "M_D_YYYY");
      let current = start.clone();
      while (current.isSameOrBefore(end, "day")) {
        foldersToScan.push(current.format("M_D_YYYY"));
        current = current.add(1, "day");
      }
    } else if (dateStart) {
      foldersToScan = [dateStart];
    } else {
      // fallback: scan all folders (slow, but only if no date selected)
      foldersToScan = fs.readdirSync(WAV_DIR).filter(f => fs.statSync(path.join(WAV_DIR, f)).isDirectory());
    }

    let wavFiles = [];
    for (const folder of foldersToScan) {
      const folderPath = path.join(WAV_DIR, folder);
      try {
        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
          const files = fs.readdirSync(folderPath)
            .filter(f => f.endsWith('.wav'))
            .map(f => `${folder}/${f}`);
          wavFiles.push(...files);
        }
      } catch (e) {
        // Ignore missing or inaccessible folders
        continue;
      }
    }

    // Filtering
    wavFiles = wavFiles.filter(file => {
      // Parse info
      const [folder, filename] = file.split('/');
      const phoneMatch = filename.match(/^(\d+)/);
      const filePhone = phoneMatch ? phoneMatch[1] : '';
      const emailMatch = filename.match(/by ([^@]+@[^ ]+)/);
      const fileEmail = emailMatch ? emailMatch[1] : '';
      const durationMatch = filename.match(/_(\d+)\.wav$/);
      const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : 0;
      const durationSec = Math.floor(durationMs / 1000);

      let match = true;
      if (phone) match = match && filePhone.includes(phone);
      if (email) match = match && fileEmail.includes(email);
      if (duration && !isNaN(duration)) {
        if (durationMode === "min") match = match && durationSec >= Number(duration);
        else match = match && durationSec <= Number(duration);
      }
      return match;
    });

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const size = parseInt(pageSize, 10) || 100;
    const total = wavFiles.length;
    const startIdx = (pageNum - 1) * size;
    const endIdx = startIdx + size;
    const filesPage = wavFiles.slice(startIdx, endIdx);

    res.json({
      files: filesPage,
      total,
      page: pageNum,
      pageSize: size,
      pageCount: Math.max(1, Math.ceil(total / size)),
    });
  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json({ files: [], total: 0, page: 1, pageSize: 100, pageCount: 0 });
  }
});

function getCachePath(originalPath) {
  // Use a hash of the original path for unique cache file names
  const hash = crypto.createHash('md5').update(originalPath).digest('hex');
  return path.join(CACHE_DIR, hash + '.wav');
}

// Stream a .wav file (support subdirectory path, with Range support for seeking)
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

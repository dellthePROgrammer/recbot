import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import crypto from 'crypto';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";

dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
const WAV_DIR = '/data/wav/recordings'; // For reference, not used with S3

app.use(cors());

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function listWavFilesFromS3(bucket, prefix = "") {
  let files = [];
  let ContinuationToken;
  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken,
    });
    const response = await s3.send(command);
    if (response.Contents) {
      files.push(...response.Contents
        .filter(obj => obj.Key.endsWith(".wav"))
        .map(obj => obj.Key));
    }
    ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return files;
}

// Stream a .wav file, transcoding and caching in S3 if needed
app.get('/api/wav-files/*', async (req, res) => {
  try {
    const s3Key = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const cacheKey = 'cache/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';

    // 1. Try to stream from S3 cache (with Range support)
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: cacheKey }));
      const range = req.headers.range;
      const params = { Bucket: BUCKET_NAME, Key: cacheKey };
      if (range) params.Range = range;
      const command = new GetObjectCommand(params);
      const s3Response = await s3.send(command);

      if (range) res.status(206);
      res.setHeader('Content-Type', 'audio/wav');
      if (s3Response.ContentLength) res.setHeader('Content-Length', s3Response.ContentLength);
      if (s3Response.ContentRange) res.setHeader('Content-Range', s3Response.ContentRange);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);

      s3Response.Body.pipe(res);
      return;
    } catch {
      // Not in cache, proceed to transcode and cache
    }

    // 2. Not in cache: download original, transcode, upload to S3 cache, then stream
    const originalCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
    const originalResponse = await s3.send(originalCommand);

    const tmpCachePath = path.join(os.tmpdir(), cacheKey.replace(/\//g, '_'));
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'wav',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', '44100',
      tmpCachePath
    ]);

    originalResponse.Body.pipe(ffmpeg.stdin);

    ffmpeg.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', (error) => {
      console.error('ffmpeg error:', error);
      res.status(500).end();
    });

    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        console.error(`ffmpeg exited with code ${code}`);
        return res.status(500).end();
      }
      try {
        const fileStream = fs.createReadStream(tmpCachePath);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: cacheKey,
          Body: fileStream,
          ContentType: 'audio/wav'
        }));
        // Stream the cached file to the client (with Range support)
        const range = req.headers.range;
        const params = { Bucket: BUCKET_NAME, Key: cacheKey };
        if (range) params.Range = range;
        const cachedCommand = new GetObjectCommand(params);
        const cachedResponse = await s3.send(cachedCommand);

        if (range) res.status(206);
        res.setHeader('Content-Type', 'audio/wav');
        if (cachedResponse.ContentLength) res.setHeader('Content-Length', cachedResponse.ContentLength);
        if (cachedResponse.ContentRange) res.setHeader('Content-Range', cachedResponse.ContentRange);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);

        cachedResponse.Body.pipe(res);

        fs.unlink(tmpCachePath, () => {});
      } catch (err) {
        console.error('S3 upload or stream error:', err);
        res.status(500).end();
      }
    });
  } catch (err) {
    console.error('Error streaming S3 file:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// List .wav files from S3, supporting date range queries
app.get('/api/wav-files', async (req, res) => {
  try {
    const BUCKET_NAME = process.env.AWS_BUCKET;
    let PREFIX = 'recordings/';
    const { 
      dateStart, 
      dateEnd, 
      offset = 0, 
      limit = 25,
      phone,
      email,
      durationMin,
      durationMode = "min",
      timeStart,
      timeEnd,
      timeMode = "range",
      sortColumn = "date",
      sortDirection = "asc"
    } = req.query;
    
    // Debug phone filter
    if (phone) {
      console.log('Phone filter received:', JSON.stringify(phone), 'Type:', typeof phone);
    }
    
    let files = [];

    if (dateStart && !dateEnd) {
      PREFIX += `${dateStart}/`;
      files = await listWavFilesFromS3(BUCKET_NAME, PREFIX);
    } else if (dateStart && dateEnd) {
      const start = dayjs(dateStart, "M_D_YYYY");
      const end = dayjs(dateEnd, "M_D_YYYY");
      let current = start.clone();
      while (current.isSameOrBefore(end, "day")) {
        const dayPrefix = `recordings/${current.format("M_D_YYYY")}/`;
        const dayFiles = await listWavFilesFromS3(BUCKET_NAME, dayPrefix);
        files.push(...dayFiles);
        current = current.add(1, "day");
      }
    } else {
      files = await listWavFilesFromS3(BUCKET_NAME, PREFIX);
    }

    // Apply filters
    const filteredFiles = files.filter(file => {
      const cleanFile = file.startsWith('recordings/') ? file.slice('recordings/'.length) : file;
      const [folder, filename] = cleanFile.split('/');
      if (!folder || !filename) return false;

      const date = folder.replace(/_/g, '/');
      const phoneMatch = filename.match(/^(\d+)/);
      const filePhone = phoneMatch ? phoneMatch[1] : '';
      const emailMatch = filename.match(/by ([^@]+@[^ ]+)/);
      const fileEmail = emailMatch ? emailMatch[1] : '';
      const timeMatch = filename.match(/@ ([\d_]+ [AP]M)/);
      const time = timeMatch ? timeMatch[1].replace(/_/g, ':') : '';
      const durationMatch = filename.match(/_(\d+)\.wav$/);
      const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : 0;
      const durationSec = Math.floor(durationMs / 1000);

      // Phone filter
      if (phone && phone.trim() !== "") {
        const phoneSearch = phone.trim();
        if (!filePhone.includes(phoneSearch)) {
          return false;
        }
      }

      // Email filter
      if (email && !fileEmail.toLowerCase().includes(email.toLowerCase())) return false;

      // Duration filter
      if (durationMin && !isNaN(durationMin)) {
        if (durationMode === "min" && durationSec < Number(durationMin)) return false;
        if (durationMode === "max" && durationSec > Number(durationMin)) return false;
      }

      // Time filter
      if (time && (timeStart || timeEnd)) {
        const fileTime = dayjs(time, "hh:mm:ss A");
        const startTime = timeStart ? dayjs(timeStart, "hh:mm:ss A") : null;
        const endTime = timeEnd ? dayjs(timeEnd, "hh:mm:ss A") : null;

        if (timeMode === "range" && startTime && endTime) {
          if (!fileTime.isValid() || fileTime.isBefore(startTime) || fileTime.isAfter(endTime)) return false;
        } else if (timeMode === "Older" && startTime) {
          if (!fileTime.isValid() || fileTime.isAfter(startTime)) return false;
        } else if (timeMode === "Newer" && startTime) {
          if (!fileTime.isValid() || fileTime.isBefore(startTime)) return false;
        }
      }

      return true;
    });

    // Apply sorting
    const sortedFiles = [...filteredFiles].sort((a, b) => {
      const cleanFileA = a.startsWith('recordings/') ? a.slice('recordings/'.length) : a;
      const cleanFileB = b.startsWith('recordings/') ? b.slice('recordings/'.length) : b;
      const [folderA, filenameA] = cleanFileA.split('/');
      const [folderB, filenameB] = cleanFileB.split('/');
      
      if (!folderA || !filenameA || !folderB || !filenameB) return 0;

      let valA, valB;

      if (sortColumn === "date") {
        const dateA = folderA.replace(/_/g, '/');
        const dateB = folderB.replace(/_/g, '/');
        valA = dayjs(dateA, "M/D/YYYY").valueOf();
        valB = dayjs(dateB, "M/D/YYYY").valueOf();
      } else if (sortColumn === "phone") {
        const phoneMatchA = filenameA.match(/^(\d+)/);
        const phoneMatchB = filenameB.match(/^(\d+)/);
        valA = phoneMatchA ? phoneMatchA[1] : '';
        valB = phoneMatchB ? phoneMatchB[1] : '';
      } else if (sortColumn === "email") {
        const emailMatchA = filenameA.match(/by ([^@]+@[^ ]+)/);
        const emailMatchB = filenameB.match(/by ([^@]+@[^ ]+)/);
        valA = emailMatchA ? emailMatchA[1] : '';
        valB = emailMatchB ? emailMatchB[1] : '';
      } else if (sortColumn === "time") {
        const timeMatchA = filenameA.match(/@ ([\d_]+ [AP]M)/);
        const timeMatchB = filenameB.match(/@ ([\d_]+ [AP]M)/);
        const timeA = timeMatchA ? timeMatchA[1].replace(/_/g, ':') : '';
        const timeB = timeMatchB ? timeMatchB[1].replace(/_/g, ':') : '';
        valA = timeA ? dayjs(timeA, "hh:mm:ss A").valueOf() : 0;
        valB = timeB ? dayjs(timeB, "hh:mm:ss A").valueOf() : 0;
      } else if (sortColumn === "durationMs") {
        const durationMatchA = filenameA.match(/_(\d+)\.wav$/);
        const durationMatchB = filenameB.match(/_(\d+)\.wav$/);
        valA = durationMatchA ? parseInt(durationMatchA[1], 10) : 0;
        valB = durationMatchB ? parseInt(durationMatchB[1], 10) : 0;
      } else {
        valA = a;
        valB = b;
      }

      // Handle string vs number comparison
      if (typeof valA === 'string' && typeof valB === 'string') {
        valA = valA.toLowerCase();
        valB = valB.toLowerCase();
      }

      let result = 0;
      if (valA < valB) result = -1;
      else if (valA > valB) result = 1;

      return sortDirection === "desc" ? -result : result;
    });

    // Apply offset-based pagination
    const offsetNum = parseInt(offset, 10) || 0;
    const limitNum = parseInt(limit, 10) || 25;
    const totalCount = sortedFiles.length;
    const paginatedFiles = sortedFiles.slice(offsetNum, offsetNum + limitNum);
    const hasMore = offsetNum + limitNum < totalCount;

    res.json({
      files: paginatedFiles,
      totalCount,
      offset: offsetNum,
      limit: limitNum,
      hasMore
    });
  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json({ files: [], totalCount: 0, offset: 0, limit: 25, hasMore: false });
  }
});

// Serve React static files
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

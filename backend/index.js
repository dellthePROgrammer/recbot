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
    const { dateStart, dateEnd } = req.query;
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

    res.json(files);
  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json([]);
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

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
import { queryFiles, indexFiles, indexFile, getDatabaseStats } from './database.js';

dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
const WAV_DIR = '/data/wav/recordings'; // For reference, not used with S3

app.use(cors());
app.use(express.json()); // Parse JSON request bodies

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
// High-performance files endpoint using database
app.get('/api/wav-files', async (req, res) => {
  try {
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
      sortDirection = "desc"
    } = req.query;

    // Use database query for ultra-fast results
    const result = queryFiles({
      dateStart,
      dateEnd,
      phone: phone?.trim() || null,
      email: email?.trim() || null,
      durationMin: durationMin ? parseInt(durationMin) : null,
      timeStart,
      timeEnd,
      sortColumn,
      sortDirection,
      limit: parseInt(limit) || 25,
      offset: parseInt(offset) || 0
    });

    // Convert database format back to frontend format
    const files = result.files.map(file => file.file_path);

    res.json({
      files,
      totalCount: result.totalCount,
      offset: parseInt(offset) || 0,
      limit: parseInt(limit) || 25,
      hasMore: result.hasMore
    });

  } catch (err) {
    console.error('Error in /api/wav-files:', err);
    res.status(500).json({ files: [], totalCount: 0, offset: 0, limit: 25, hasMore: false });
  }
});

// Database sync/indexing endpoint for initial setup and maintenance
app.post('/api/sync-database', async (req, res) => {
  try {
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const { dateRange, forceReindex = false } = req.body || {};

    console.log(`📊 [SYNC] ${dateRange ? 'Date range' : 'Full'} sync requested`);

    console.log('Starting database sync...');
    const startTime = Date.now();
    let indexedCount = 0;

    if (dateRange) {
      // Sync specific date range
      const { startDate, endDate } = dateRange;
      const start = dayjs(startDate, "M_D_YYYY");
      const end = dayjs(endDate, "M_D_YYYY");
      let current = start.clone();

      while (current.isSameOrBefore(end, "day")) {
        const dayPrefix = `recordings/${current.format("M_D_YYYY")}/`;
        console.log(`Indexing files for ${current.format("M_D_YYYY")}...`);
        
        const dayFiles = await listWavFilesFromS3(BUCKET_NAME, dayPrefix);
        if (dayFiles.length > 0) {
          const batchIndexed = indexFiles(dayFiles);
          indexedCount += batchIndexed;
          console.log(`Indexed ${batchIndexed}/${dayFiles.length} files for ${current.format("M_D_YYYY")}`);
        }
        
        current = current.add(1, "day");
      }
    } else {
      // Full sync - be careful with 300k+ files!
      console.log('WARNING: Full sync initiated - this may take a while...');
      const allFiles = await listWavFilesFromS3(BUCKET_NAME, 'recordings/');
      console.log(`Found ${allFiles.length} total files to index`);
      
      // Process in batches of 1000 for memory efficiency
      const batchSize = 1000;
      for (let i = 0; i < allFiles.length; i += batchSize) {
        const batch = allFiles.slice(i, i + batchSize);
        const batchIndexed = indexFiles(batch);
        indexedCount += batchIndexed;
        
        console.log(`Batch ${Math.floor(i/batchSize) + 1}: Indexed ${batchIndexed}/${batch.length} files (Total: ${indexedCount}/${allFiles.length})`);
        
        // Brief pause to prevent overwhelming the system
        if (i + batchSize < allFiles.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    const stats = getDatabaseStats();
    
    res.json({
      success: true,
      indexedFiles: indexedCount,
      duration: `${duration.toFixed(2)}s`,
      databaseStats: stats
    });

  } catch (err) {
    console.error('Error syncing database:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Database statistics endpoint
app.get('/api/database-stats', (req, res) => {
  try {
    const stats = getDatabaseStats();
    res.json(stats);
  } catch (err) {
    console.error('Error getting database stats:', err);
    res.status(500).json({ error: err.message });
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

// Auto-sync function for current day
async function syncCurrentDay() {
  try {
    const BUCKET_NAME = process.env.AWS_BUCKET;
    const today = dayjs().format("M_D_YYYY");
    const dayPrefix = `recordings/${today}/`;
    
    console.log(`🔄 [AUTO-SYNC] Checking current day: ${today}`);
    
    const dayFiles = await listWavFilesFromS3(BUCKET_NAME, dayPrefix);
    
    if (dayFiles.length > 0) {
      const indexedCount = indexFiles(dayFiles);
      console.log(`✅ [AUTO-SYNC] Indexed ${indexedCount}/${dayFiles.length} files for ${today}`);
    } else {
      console.log(`📁 [AUTO-SYNC] No files found for ${today}`);
    }
  } catch (error) {
    console.error(`❌ [AUTO-SYNC] Error during current day sync:`, error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  
  // Start automatic current day sync every 5 minutes
  console.log(`🕒 [AUTO-SYNC] Starting automatic current day sync (every 5 minutes)`);
  
  // Run initial sync after 30 seconds (give server time to fully start)
  setTimeout(() => {
    console.log(`🚀 [AUTO-SYNC] Running initial current day sync...`);
    syncCurrentDay();
  }, 30000);
  
  // Then run every 5 minutes
  setInterval(syncCurrentDay, 5 * 60 * 1000); // 5 minutes in milliseconds
});

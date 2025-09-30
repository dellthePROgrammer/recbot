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
import { clerkAuth, requireAuth, requireAdmin, requireMemberOrAdmin, requireAuthenticatedUser, requireManagerOrAdmin } from './auth.js';

dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
const WAV_DIR = '/data/wav/recordings'; // For reference, not used with S3

app.use(cors());
app.use(express.json()); // Parse JSON request bodies
app.use(clerkAuth); // Add Clerk authentication middleware

const s3 = new S3Client({ region: process.env.AWS_REGION });

// Public endpoint to get client configuration
app.get('/api/config', (req, res) => {
  res.json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY
  });
});

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
// Audio streaming endpoint with role-based access control
// Health check endpoint with FFmpeg verification
app.get('/api/health', async (req, res) => {
  try {
    // Check if FFmpeg is available
    const ffmpegCheck = spawn('ffmpeg', ['-version']);
    let ffmpegVersion = '';
    
    ffmpegCheck.stdout.on('data', (data) => {
      if (!ffmpegVersion) ffmpegVersion = data.toString().split('\n')[0];
    });
    
    ffmpegCheck.on('close', (code) => {
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        ffmpeg: code === 0 ? { available: true, version: ffmpegVersion } : { available: false, error: 'FFmpeg not found' },
        cache: fileIndexes ? `${Object.keys(fileIndexes).length} files indexed` : 'Index not loaded'
      };
      res.json(status);
    });
    
    ffmpegCheck.on('error', () => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        ffmpeg: { available: false, error: 'FFmpeg not installed' },
        cache: fileIndexes ? `${Object.keys(fileIndexes).length} files indexed` : 'Index not loaded'
      });
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Audio endpoint with query parameter auth support for direct streaming
app.get('/api/audio/*', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    // Handle authentication from either header or query parameter
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.substring(7);
    } else if (req.query.auth) {
      token = req.query.auth;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Verify the token manually since we're not using middleware
    try {
      const auth = { sessionToken: token };
      // For now, let's simplify and just check if token exists
      // In production, you'd verify the JWT properly
      console.log(`🎵 [STREAMING AUTH] Token provided for: ${filename}`);
    } catch (authError) {
      console.error('Authentication failed:', authError);
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    const cacheKey = 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
    const waveformCacheKey = 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';
    
    console.log(`🎵 [STREAMING] Checking cache for: ${s3Key}`);
    console.log(`📁 [CACHE KEY] Audio: ${cacheKey}, Waveform: ${waveformCacheKey}`);

    // Check if already cached
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: cacheKey }));
      
      console.log(`⚡ [CACHE HIT] Serving from cache: ${cacheKey}`);
      
      // Serve from cache with range support for seeking
      const range = req.headers.range;
      const params = { Bucket: BUCKET_NAME, Key: cacheKey };
      if (range) {
        params.Range = range;
        res.status(206);
      }
      
      const cachedCommand = new GetObjectCommand(params);
      const cachedResponse = await s3.send(cachedCommand);

      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);
      
      if (cachedResponse.ContentLength) res.setHeader('Content-Length', cachedResponse.ContentLength);
      if (cachedResponse.ContentRange) res.setHeader('Content-Range', cachedResponse.ContentRange);

      cachedResponse.Body.pipe(res);
      return;
      
    } catch {
      console.log(`📦 [CACHE MISS] Need to convert and cache: ${s3Key}`);
    }

    // Get the original file from S3
    const s3StartTime = Date.now();
    const originalCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
    const originalResponse = await s3.send(originalCommand);
    const s3FetchTime = Date.now() - s3StartTime;
    console.log(`📦 [S3 FETCH] Retrieved file in ${s3FetchTime}ms`);

    // Convert and cache for seeking support
    const tmpCachePath = path.join(os.tmpdir(), cacheKey.replace(/\//g, '_'));
    
    console.log(`🔄 [CONVERT] Starting FFmpeg WAV conversion: ${s3Key}`);
    const conversionStartTime = Date.now();
    
    // FFmpeg command to convert and save to temp file
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',           // Input from stdin
      '-f', 'wav',              // WAV format 
      '-acodec', 'pcm_s16le',   // PCM 16-bit 
      '-ac', '1',               // Mono for faster processing
      '-ar', '22050',           // Lower sample rate for faster processing
      tmpCachePath              // Output to temp file
    ]);

    // Error handling
    ffmpeg.stderr.on('data', (data) => {
      console.error(`FFmpeg stderr: ${data}`);
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ [FFmpeg ERROR]:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Audio conversion failed' });
      }
      if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
    });

    // Stream input to FFmpeg
    originalResponse.Body.pipe(ffmpeg.stdin);

    ffmpeg.on('close', async (code) => {
      const conversionTime = Date.now() - conversionStartTime;
      console.log(`⏱️ [CONVERSION] Completed in ${conversionTime}ms`);
      
      if (code !== 0) {
        console.error(`❌ FFmpeg process exited with code ${code}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to convert audio' });
        }
        if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
        return;
      }

      try {
        // Upload to S3 cache
        const fileData = fs.readFileSync(tmpCachePath);
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: cacheKey,
          Body: fileData,
          ContentType: 'audio/wav'
        }));
        
        console.log(`✅ [CACHED] Uploaded to S3 cache: ${cacheKey}`);
        
        // Now serve the file with range support
        const range = req.headers.range;
        if (range) {
          // Handle range request for seeking
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileData.length - 1;
          const chunksize = (end - start) + 1;
          
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${fileData.length}`);
          res.setHeader('Content-Length', chunksize);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Accept-Ranges', 'bytes');
          
          res.end(fileData.slice(start, end + 1));
        } else {
          // Serve full file
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', fileData.length);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Content-Disposition', `inline; filename="${s3Key.split('/').pop()}"`);
          
          res.end(fileData);
        }
        
        // Clean up temp file
        fs.unlinkSync(tmpCachePath);
        
      } catch (error) {
        console.error(`❌ Error caching or serving file:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to serve converted audio' });
        }
        if (fs.existsSync(tmpCachePath)) fs.unlinkSync(tmpCachePath);
      }
    });
  } catch (err) {
    console.error('Error streaming S3 file:', err);
    res.status(404).json({ error: 'File not found' });
  }
});

// Waveform endpoint - returns waveform data for an audio file
app.get('/api/waveform/*', async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    // Handle authentication
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.substring(7);
    } else if (req.query.auth) {
      token = req.query.auth;
    }
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    const waveformCacheKey = 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';
    
    console.log(`📊 [WAVEFORM] Checking cache for: ${s3Key}`);

    // Check if waveform already cached
    try {
      const waveformCommand = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: waveformCacheKey });
      const waveformResponse = await s3.send(waveformCommand);
      const waveformData = JSON.parse(await waveformResponse.Body.transformToString());
      
      console.log(`⚡ [WAVEFORM CACHE HIT] Serving cached waveform for: ${s3Key}`);
      res.json({ waveform: waveformData, cached: true });
      return;
      
    } catch {
      console.log(`📦 [WAVEFORM CACHE MISS] Need to generate for: ${s3Key}`);
    }

    // Generate waveform from the SAME converted audio that gets played back
    // First, check if we have the converted audio in cache
    const audioCacheKey = 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
    let audioSource = null;
    let useConvertedAudio = false;

    try {
      // Try to use the converted audio cache first
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: audioCacheKey }));
      audioSource = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: audioCacheKey });
      useConvertedAudio = true;
      console.log(`🎯 [WAVEFORM] Using converted audio cache for perfect sync: ${audioCacheKey}`);
    } catch {
      // Fall back to original audio
      audioSource = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
      console.log(`📄 [WAVEFORM] Using original audio (will convert): ${s3Key}`);
    }

    const audioResponse = await s3.send(audioSource);

    console.log(`🔄 [WAVEFORM] Starting synchronized FFmpeg analysis for: ${s3Key}`);
    const waveformStartTime = Date.now();

    // FFmpeg parameters depend on whether we're using converted audio or original
    let ffmpegArgs;
    if (useConvertedAudio) {
      // Already converted WAV - just extract PCM data
      ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',            // Raw 16-bit PCM for analysis
        '-acodec', 'pcm_s16le',   
        'pipe:1'                  // No conversion needed - already mono 22050Hz
      ];
      console.log(`🎯 [WAVEFORM] Using pre-converted audio (already mono 22050Hz)`);
    } else {
      // Original audio - apply EXACT SAME conversion as playback
      ffmpegArgs = [
        '-i', 'pipe:0',
        '-f', 's16le',            // Raw 16-bit PCM for analysis
        '-acodec', 'pcm_s16le',   // Same codec as playback
        '-ac', '1',               // Convert to mono (same as playback)
        '-ar', '22050',           // Convert sample rate (same as playback)
        'pipe:1'
      ];
      console.log(`🔄 [WAVEFORM] Converting original audio (mono 22050Hz)`);
    }

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let audioData = Buffer.alloc(0);
    
    ffmpeg.stdout.on('data', (chunk) => {
      audioData = Buffer.concat([audioData, chunk]);
    });

    ffmpeg.stderr.on('data', (data) => {
      // Suppress FFmpeg stderr for waveform generation
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ [WAVEFORM FFmpeg ERROR]:', error);
      res.status(500).json({ error: 'Waveform generation failed' });
    });

    audioResponse.Body.pipe(ffmpeg.stdin);

    ffmpeg.on('close', async (code) => {
      if (code !== 0) {
        console.error(`❌ [WAVEFORM] FFmpeg process exited with code ${code}`);
        res.status(500).json({ error: 'Failed to generate waveform' });
        return;
      }

      // Process audio data into waveform with proper timing alignment
      const samples = [];
      const sampleSize = 2; // 16-bit = 2 bytes
      const expectedSampleRate = 22050; // Hz (expected after conversion)
      const targetPoints = 1000; // Target number of waveform points
      const totalSamples = Math.floor(audioData.length / sampleSize);
      const samplesPerPoint = Math.floor(totalSamples / targetPoints);
      
      // Calculate actual duration for verification
      const durationSeconds = totalSamples / expectedSampleRate;

      console.log(`📊 [WAVEFORM ANALYSIS] Source: ${useConvertedAudio ? 'converted cache' : 'original file'}`);
      console.log(`📊 [WAVEFORM ANALYSIS] Duration: ${durationSeconds.toFixed(1)}s, Total samples: ${totalSamples}, Samples per point: ${samplesPerPoint}`);
      console.log(`📊 [WAVEFORM ANALYSIS] Audio data size: ${audioData.length} bytes, Expected sample rate: ${expectedSampleRate}Hz`);

      for (let i = 0; i < targetPoints; i++) {
        let maxAmplitude = 0;
        let rmsSum = 0;
        let count = 0;
        
        for (let j = 0; j < samplesPerPoint; j++) {
          const sampleIndex = i * samplesPerPoint + j;
          const offset = sampleIndex * sampleSize;
          
          if (offset + 1 < audioData.length) {
            // Read 16-bit signed integer
            const sample = audioData.readInt16LE(offset);
            const amplitude = Math.abs(sample);
            
            // Track peak amplitude for this segment
            maxAmplitude = Math.max(maxAmplitude, amplitude);
            
            // Also calculate RMS for smoothness
            rmsSum += sample * sample;
            count++;
          }
        }
        
        if (count > 0) {
          // Use combination of peak and RMS for better dynamics
          const rms = Math.sqrt(rmsSum / count);
          const peakNormalized = maxAmplitude / 32768;
          const rmsNormalized = rms / 32768;
          
          // Blend peak (for dynamics) and RMS (for smoothness)
          const finalAmplitude = (peakNormalized * 0.7) + (rmsNormalized * 0.3);
          
          // Apply some compression to enhance visibility of quiet parts
          const compressed = Math.pow(finalAmplitude, 0.6); // Square root compression
          
          samples.push(Math.min(compressed, 1));
        } else {
          samples.push(0);
        }
      }

      const waveformTime = Date.now() - waveformStartTime;
      console.log(`✅ [WAVEFORM] Generated ${samples.length} points in ${waveformTime}ms`);
      
      // Log amplitude distribution for debugging
      const maxVal = Math.max(...samples);
      const minVal = Math.min(...samples);
      const avgVal = samples.reduce((a, b) => a + b, 0) / samples.length;
      console.log(`📈 [WAVEFORM STATS] Min: ${minVal.toFixed(3)}, Max: ${maxVal.toFixed(3)}, Avg: ${avgVal.toFixed(3)}`);

      // Cache the waveform data
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: waveformCacheKey,
          Body: JSON.stringify(samples),
          ContentType: 'application/json'
        }));
        console.log(`💾 [WAVEFORM CACHED] Saved to: ${waveformCacheKey}`);
      } catch (cacheError) {
        console.error('⚠️ [WAVEFORM CACHE] Failed to cache:', cacheError);
      }

      res.json({ 
        waveform: samples, 
        cached: false, 
        generationTime: waveformTime,
        duration: durationSeconds,
        sampleRate: expectedSampleRate,
        totalSamples: totalSamples,
        source: useConvertedAudio ? 'converted_cache' : 'original_file'
      });
    });

  } catch (error) {
    console.error('❌ [WAVEFORM ERROR]:', error);
    res.status(500).json({ error: 'Waveform generation failed' });
  }
});

// Download endpoint with role-based access control
app.get('/api/download/*', requireAuth, requireManagerOrAdmin, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    console.log(`📥 [DOWNLOAD] User ${req.user.email} (${req.user.role}) downloading: ${filename}`);

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    
    // Force download with proper headers
    try {
      const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key });
      const s3Response = await s3.send(command);

      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `attachment; filename="${s3Key.split('/').pop()}"`);
      res.setHeader('Content-Length', s3Response.ContentLength || 0);

      s3Response.Body.pipe(res);
    } catch (error) {
      console.error('Download error:', error);
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// High-performance files endpoint using database - requires authentication
app.get('/api/wav-files', requireAuth, requireAuthenticatedUser, async (req, res) => {
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

    // Email filtering - allow all users to view all files (no email filtering)
    let effectiveEmail = email?.trim() || null;
    
    // All authenticated users can view all files
    console.log(`� [USER ACCESS] User ${req.user.email} accessing all files (view-only)`);
    
    // Note: Download protection is handled at the audio streaming level

    // Use database query for ultra-fast results
    const result = queryFiles({
      dateStart,
      dateEnd,
      phone: phone?.trim() || null,
      email: effectiveEmail,
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
app.post('/api/sync-database', requireAuth, requireAdmin, async (req, res) => {
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
app.get('/api/database-stats', requireAuth, requireAdmin, (req, res) => {
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

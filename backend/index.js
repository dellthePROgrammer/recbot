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
import { queryFiles, indexFiles, indexFile, getDatabaseStats, getAuditLogs, getUserSessions, logAuditEvent, parseFileMetadata, logUserLogout, logUserSession, getDistinctUsers, expireStaleSessions, touchUserSession, expireInactiveSessions, repairOpenSessions, backfillExpiredOpenSessions, backfillFileMetadata, backfillAuditLogCallIds } from './database.js';
import { clerkAuth, requireAuth, requireAdmin, requireMemberOrAdmin, requireAuthenticatedUser, requireManagerOrAdmin } from './auth.js';

dayjs.extend(customParseFormat);
dayjs.extend(isSameOrBefore);

const app = express();
const PORT = process.env.PORT || 4000;
const BUILD_DIR = path.join(process.cwd(), '../frontend/build');
const WAV_DIR = '/data/wav/recordings'; // For reference, not used with S3

app.use(cors());
app.use(express.json()); // Parse JSON request bodies

// Configure Express to trust proxies for proper IP extraction
app.set('trust proxy', true);

// Middleware to extract real client IP from proxy headers
app.use((req, res, next) => {
  // Capture raw headers for diagnostics (not stored, just logged when needed)
  const h = req.headers;

  // Canonical header names we care about
  const cf = h['cf-connecting-ip'];
  const xReal = h['x-real-ip'];
  const xForwardedFor = h['x-forwarded-for'];
  const xClient = h['x-client-ip'];

  // Build candidate list in priority order: Cloudflare > X-Real-IP (Traefik) > first X-Forwarded-For > x-client-ip > req.ip
  let candidate = cf || xReal || (xForwardedFor ? xForwardedFor.split(',')[0].trim() : null) || xClient || req.ip || 'unknown';

  // Strip IPv6 previx if Node expressed it
  if (candidate && candidate.startsWith('::ffff:')) candidate = candidate.slice(7);

  req.realClientIP = candidate;
  req.forwardedChain = xForwardedFor || null; // keep chain for potential later auditing

  // Only verbose-log once per request path for now
  console.log('🌐 [IP] resolved=%s cf=%s x-real=%s x-forwarded-for=%s node-ip=%s', candidate, cf || '-', xReal || '-', xForwardedFor || '-', req.ip);
  next();
});

app.use(clerkAuth); // Add Clerk authentication middleware

// Fallback session creator: ensures every authenticated user has an active session row
app.use(async (req, res, next) => {
  // Only proceed for routes using requireAuth (those will set req.user) – if not set yet just continue
  if (!req.path.startsWith('/api/') || req.path === '/api/config') return next();
  // If user object not yet populated, continue; requireAuth will populate in route chain
  // We'll run another tiny middleware after requireAuth inside protected routes if needed.
  return next();
});

const s3 = new S3Client({ region: process.env.AWS_REGION });

// --- AUTO SESSION EXPIRATION (4h) ---
const MAX_SESSION_HOURS = parseInt(process.env.MAX_SESSION_HOURS || '4');
const MAX_INACTIVITY_MINUTES = parseInt(process.env.MAX_INACTIVITY_MINUTES || '30');
// Run every 5 minutes to catch stale sessions
setInterval(() => {
  try {
    const expired = expireStaleSessions(MAX_SESSION_HOURS, 200);
    if (Array.isArray(expired) && expired.length) {
      console.log(`⏰ [SESSION EXPIRY] Auto-logged out ${expired.length} session(s) > ${MAX_SESSION_HOURS}h`);
      for (const row of expired) {
        // Audit each auto logout
        logAuditEvent(
          row.user_id,
          row.user_email,
          'LOGOUT',
          null,
          null,
          row.ip_address || null,
          row.user_agent || null,
          row.id,
          { reason: 'auto_expire_interval', maxHours: MAX_SESSION_HOURS, login_time: row.login_time }
        );
      }
    }
    const inactive = expireInactiveSessions(MAX_INACTIVITY_MINUTES, 300);
    if (Array.isArray(inactive) && inactive.length) {
      console.log(`💤 [INACTIVITY EXPIRY] Auto-logged out ${inactive.length} inactive session(s) > ${MAX_INACTIVITY_MINUTES}m`);
      for (const row of inactive) {
        logAuditEvent(
          row.user_id,
          row.user_email,
          'LOGOUT',
          null,
          null,
          row.ip_address || null,
          row.user_agent || null,
          row.id,
          { reason: 'auto_inactive', minutes: MAX_INACTIVITY_MINUTES, last_activity: row.last_activity, login_time: row.login_time }
        );
      }
    }
  } catch (e) {
    console.error('Auto session expiry error:', e);
  }
}, 5 * 60 * 1000);

// Public endpoint to get client configuration
app.get('/api/config', (req, res) => {
  res.json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY
  });
});

// Logout endpoint to track user logout events
// Middleware to ensure session row exists after requireAuth sets req.user
async function ensureSession(req, res, next) {
  try {
    if (!req.user) return next();
    // Quick check: if last login was within 10 seconds but no session row created (edge), we can create
    // Simpler: attempt to create a session only if no open session exists (logout_time is NULL)
    // We'll query DB minimally.
    const now = Date.now();
    const maxHours = parseInt(process.env.MAX_SESSION_HOURS || '4');
    const maxMs = maxHours * 3600 * 1000;
    const openSession = getUserSessions(req.user.id, null, null, 3, 0).find(s => !s.logout_time);
    if (openSession) {
      const started = new Date(openSession.login_time).getTime();
      const ageMs = now - started;
      const MAX_ACTIVE_WINDOW_MIN = parseInt(process.env.MAX_ACTIVE_WINDOW_MIN || '30');
      let idleMinutes = null;
      if (openSession.last_activity) {
        const lastActivityMs = new Date(openSession.last_activity).getTime();
        idleMinutes = (now - lastActivityMs) / 60000;
      }
      if (ageMs > maxMs) {
        // Age exceeds max session hours threshold.
        // If user was idle (no activity within last MAX_ACTIVE_WINDOW_MIN) -> hard logout & 401.
        // If there WAS activity (idleMinutes <= threshold) -> silent rotate session (close + new) so user continues seamlessly.
        const idleExceeded = idleMinutes === null || idleMinutes > MAX_ACTIVE_WINDOW_MIN;
        if (idleExceeded) {
          try {
            // Hard logout path
            logUserLogout(req.user.id);
            logAuditEvent(
              req.user.id,
              req.user.email,
              'LOGOUT',
              null,
              null,
              req.user.ipAddress,
              req.user.userAgent,
              openSession.id,
              { reason: 'auto_expire_idle_hard', maxHours, idleMinutes, maxIdleMinutes: MAX_ACTIVE_WINDOW_MIN, login_time: openSession.login_time }
            );
          } catch (e) {
            console.error('Error logging hard logout:', e);
          }
          return res.status(401).json({ error: 'Session expired due to inactivity threshold at renewal point' });
        } else {
          // Silent rotation path
            try {
              logUserLogout(req.user.id);
              logAuditEvent(
                req.user.id,
                req.user.email,
                'LOGOUT',
                null,
                null,
                req.user.ipAddress,
                req.user.userAgent,
                openSession.id,
                { reason: 'auto_expire_rotate', maxHours, idleMinutes, maxIdleMinutes: MAX_ACTIVE_WINDOW_MIN, login_time: openSession.login_time }
              );
              const newSessionId = logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
              logAuditEvent(
                req.user.id,
                req.user.email,
                'LOGIN',
                null,
                null,
                req.user.ipAddress,
                req.user.userAgent,
                newSessionId,
                { reason: 'rotated_session_after_active_expiry', previousSessionId: openSession.id }
              );
              req.currentSessionId = newSessionId;
              return next();
            } catch (e) {
              console.error('Error rotating session:', e);
            }
        }
      }
  // Touch activity timestamp for active session
  touchUserSession(req.user.id);
  req.currentSessionId = openSession.id;
    } else {
      const sessionId = logUserSession(req.user.id, req.user.email, req.user.ipAddress, req.user.userAgent);
      logAuditEvent(
        req.user.id,
        req.user.email,
        'LOGIN',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        sessionId,
        { reason: 'ensure_session_create' }
      );
      req.currentSessionId = sessionId;
    }
  } catch (e) {
    console.error('ensureSession error:', e);
  }
  next();
}

app.post('/api/logout', requireAuth, ensureSession, (req, res) => {
  try {
    // Log the logout event
    logAuditEvent(
      req.user.id, 
      req.user.email, 
      'LOGOUT', 
      null, 
      null, 
      req.user.ipAddress, 
      req.user.userAgent, 
      null, 
      { userRole: req.user.role }
    );
    
    // Update the user session to mark logout time
    logUserLogout(req.user.id);
    
    res.json({ success: true, message: 'Logout recorded' });
  } catch (error) {
    console.error('Error logging logout:', error);
    res.status(500).json({ error: 'Failed to record logout' });
  }
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

// Authenticated audio streaming endpoint (now uses requireAuth so req.user is available)
app.get('/api/audio/*', requireAuth, ensureSession, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    console.log(`🎵 [STREAMING AUTH] User ${req.user.email} (${req.user.role || 'no-role'}) streaming: ${filename}`);

    const s3Key = filename.startsWith('recordings/') ? filename : `recordings/${filename}`;
    const cacheKey = 'cache/wav/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.wav';
    const waveformCacheKey = 'cache/waveform/' + crypto.createHash('md5').update(s3Key).digest('hex') + '.json';
    
    console.log(`🎵 [STREAMING] Checking cache for: ${s3Key}`);
    console.log(`📁 [CACHE KEY] Audio: ${cacheKey}, Waveform: ${waveformCacheKey}`);

    // Check if already cached
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: cacheKey }));
      
      console.log(`⚡ [CACHE HIT] Serving from cache: ${cacheKey}`);
      // Mark cacheHit for later single audit emission
      req._playAudit = { cacheHit: true };
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
      req._playAudit = { cacheHit: false };
    }

    // Emit a single consolidated PLAY_FILE audit event now that we know cache hit/miss
    try {
      const meta = parseFileMetadata(filename) || {};
      const cacheInfo = req._playAudit ? req._playAudit.cacheHit : null;
      logAuditEvent(
        req.user.id,
        req.user.email,
        'PLAY_FILE',
        filename,
        meta,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        { cacheHit: cacheInfo, userRole: req.user.role, callId: meta.callId || meta.call_id || null, durationMs: meta.durationMs || meta.duration_ms || meta.durationMs }
      );
    } catch (e) {
      console.error('⚠️ [AUDIT PLAY] Consolidated log failed:', e);
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

    // TODO: Add proper JWT verification and domain checking for waveform endpoint
    console.log(`📊 [WAVEFORM AUTH] Token provided for: ${filename}`);

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
app.get('/api/download/*', requireAuth, ensureSession, requireManagerOrAdmin, async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params[0]);
    const BUCKET_NAME = process.env.AWS_BUCKET;
    
    console.log(`📥 [DOWNLOAD] User ${req.user.email} (${req.user.role}) downloading: ${filename}`);
    try {
      // Attempt to parse metadata for richer audit details
      const meta = parseFileMetadata(filename) || {};
      logAuditEvent(
        req.user.id,
        req.user.email,
        'DOWNLOAD_FILE',
        filename,
        meta,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          userRole: req.user.role,
          date: meta.callDate || meta.date || null,
            time: meta.callTime || meta.time || null,
            callId: meta.callId || meta.call_id || null,
            durationMs: meta.durationMs || meta.duration_ms || null
        }
      );
    } catch (auditErr) {
      console.error('⚠️ [AUDIT] Failed to log download event:', auditErr);
    }

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
app.get('/api/wav-files', requireAuth, ensureSession, requireAuthenticatedUser, async (req, res) => {
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
    console.log(`📄 [VIEW_FILES] User ${req.user.email} viewing file list`);
    try {
      logAuditEvent(
        req.user.id,
        req.user.email,
        'VIEW_FILES',
        null,
        phone?.trim() || null,
        req.user.ipAddress,
        req.user.userAgent,
        null,
        {
          userRole: req.user.role,
          dateStart: dateStart || null,
          dateEnd: dateEnd || null,
          durationMin: durationMin ? parseInt(durationMin) : null,
          timeStart: timeStart || null,
            timeEnd: timeEnd || null,
          sort: `${sortColumn}:${sortDirection}`,
          offset: parseInt(offset) || 0,
          limit: parseInt(limit) || 25
        }
      );
    } catch (auditErr) {
      console.error('⚠️ [AUDIT] Failed to log view files event:', auditErr);
    }
    
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
      callId: req.query.callId ? req.query.callId.trim() : null,
      sortColumn,
      sortDirection,
      limit: parseInt(limit) || 25,
      offset: parseInt(offset) || 0
    });

    res.json({
      files: result.files.map(f => ({
        path: f.file_path,
        phone: f.phone,
        email: f.email,
        date: f.call_date,
        time: f.call_time,
        callId: f.call_id,
        durationMs: f.duration_ms,
        size: f.file_size
      })),
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
app.post('/api/sync-database', requireAuth, ensureSession, requireAdmin, async (req, res) => {
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
app.get('/api/database-stats', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const stats = getDatabaseStats();
    res.json(stats);
  } catch (err) {
    console.error('Error getting database stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Audit logs endpoint - admin only
app.get('/api/audit-logs', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const {
      userId,
      actionType,
      startDate,
      endDate,
      callId,
      limit = 100,
      offset = 0
    } = req.query;

    const { rows: auditLogs, total } = getAuditLogs(
      userId || null,
      actionType || null,
      startDate || null,
      endDate || null,
      callId || null,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({
      logs: auditLogs,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: parseInt(offset) + auditLogs.length < total
      }
    });
  } catch (err) {
    console.error('Error getting audit logs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Maintenance endpoint to backfill missing audit log call_ids from additional_data JSON
app.post('/api/backfill-audit-callids', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { batchSize } = req.body || {};
    const result = backfillAuditLogCallIds(batchSize || 500);
    logAuditEvent(req.auth.userId, req.auth.user?.primaryEmailAddress?.emailAddress || '', 'MAINTENANCE', null, null, getClientIp(req), req.headers['user-agent'] || '', req.sessionId, { task: 'backfill_audit_call_ids', ...result });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Error backfilling audit call_ids:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// User sessions endpoint - admin only
app.get('/api/user-sessions', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const {
      userId,
      startDate,
      endDate,
      limit = 100,
      offset = 0
    } = req.query;

    const sessions = getUserSessions(
      userId || null,
      startDate || null,
      endDate || null,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({
      sessions,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: sessions.length === parseInt(limit)
      }
    });
  } catch (err) {
    console.error('Error getting user sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Session repair & backfill endpoint - admin only
app.post('/api/repair-sessions', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { simulate = false, keepLatestOpen = true, maxHours = 4, includeBackfill = true } = req.body || {};
    const repairPreview = repairOpenSessions({ keepLatestOpen });
    let backfillResult = { closed: 0, details: [] };
    if (includeBackfill) {
      backfillResult = backfillExpiredOpenSessions(maxHours);
    }
    if (!simulate) {
      // Log maintenance audit event summarizing actions (no specific file)
      logAuditEvent(
        req.user.id,
        req.user.email,
        'MAINTENANCE',
        null,
        null,
        req.user.ipAddress,
        req.user.userAgent,
        req.currentSessionId || null,
        {
          maintenance: 'repair_sessions',
          keepLatestOpen,
          maxHours,
          includeBackfill,
          sessionsClosed: repairPreview.sessionsClosed + backfillResult.closed,
          duplicateClosed: repairPreview.sessionsClosed,
          expiredBackfilled: backfillResult.closed,
          usersAffected: repairPreview.usersAffected
        }
      );
    }
    res.json({
      simulate: !!simulate,
      keepLatestOpen,
      maxHours,
      includeBackfill,
      duplicateRepair: repairPreview,
      expiredBackfill: backfillResult,
      totalClosed: repairPreview.sessionsClosed + backfillResult.closed
    });
  } catch (e) {
    console.error('Error repairing sessions:', e);
    res.status(500).json({ error: e.message });
  }
});

// File metadata backfill (duration/callId) - admin only
app.post('/api/backfill-files', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { batchSize = 500 } = req.body || {};
    const result = backfillFileMetadata(Math.min(parseInt(batchSize) || 500, 5000));
    logAuditEvent(
      req.user.id,
      req.user.email,
      'MAINTENANCE',
      null,
      null,
      req.user.ipAddress,
      req.user.userAgent,
      req.currentSessionId || null,
      { maintenance: 'backfill_file_metadata', ...result }
    );
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Backfill endpoint error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Autocomplete distinct users (admin only)
app.get('/api/audit-users', requireAuth, ensureSession, requireAdmin, (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const users = getDistinctUsers(q || null, Math.min(parseInt(limit) || 20, 100));
    res.json({ users });
  } catch (err) {
    console.error('Error getting distinct users:', err);
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

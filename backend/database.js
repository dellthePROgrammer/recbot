import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const DB_PATH = process.env.DB_PATH || '/root/db/recbot.db';

// Initialize database
const db = new Database(DB_PATH);

// Enable WAL mode for better performance with concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = 10000');
db.pragma('temp_store = MEMORY');

// Create files table for metadata indexing
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    phone TEXT,
    email TEXT,
    call_date TEXT,  -- Store as YYYY-MM-DD for easy querying
    call_time TEXT,  -- Store as HH:MM:SS
    duration_ms INTEGER,
    file_size INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Create indexes for fast querying
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_files_phone ON files(phone);
  CREATE INDEX IF NOT EXISTS idx_files_email ON files(email);
  CREATE INDEX IF NOT EXISTS idx_files_call_date ON files(call_date);
  CREATE INDEX IF NOT EXISTS idx_files_call_time ON files(call_time);
  CREATE INDEX IF NOT EXISTS idx_files_duration ON files(duration_ms);
  CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);
  CREATE INDEX IF NOT EXISTS idx_files_composite ON files(call_date, phone, email);
`);

// Create audit logging tables
db.exec(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    session_duration_ms INTEGER,
    ip_address TEXT,
    user_agent TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action_type TEXT NOT NULL, -- 'LOGIN', 'LOGOUT', 'PLAY_FILE', 'DOWNLOAD_FILE', 'VIEW_FILES'
    file_path TEXT, -- For file-related actions
    file_phone TEXT, -- Phone from file metadata
    file_email TEXT, -- Email from file metadata
    action_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT,
    session_id TEXT,
    additional_data TEXT -- JSON string for extra context
  );
`);

// Create indexes for audit logs
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_email ON user_sessions(user_email);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON audit_logs(action_type);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(action_timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user_email ON audit_logs(user_email);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_file_path ON audit_logs(file_path);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, action_type, action_timestamp);
`);

// Prepared statements for performance
const statements = {
  // Insert or update file metadata
  upsertFile: db.prepare(`
    INSERT INTO files (file_path, phone, email, call_date, call_time, duration_ms, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      phone = excluded.phone,
      email = excluded.email,
      call_date = excluded.call_date,
      call_time = excluded.call_time,
      duration_ms = excluded.duration_ms,
      file_size = excluded.file_size,
      updated_at = CURRENT_TIMESTAMP
  `),
  
  // Get files with pagination and filtering
  getFiles: db.prepare(`
    SELECT 
      file_path,
      phone,
      email,
      call_date,
      call_time,
      duration_ms,
      file_size
    FROM files
    WHERE 1=1
      AND (? IS NULL OR call_date >= ?)
      AND (? IS NULL OR call_date <= ?)
      AND (? IS NULL OR phone LIKE '%' || ? || '%')
      AND (? IS NULL OR email LIKE '%' || ? || '%')
      AND (? IS NULL OR duration_ms >= ? * 1000)
      AND (? IS NULL OR call_time >= ?)
      AND (? IS NULL OR call_time <= ?)
    ORDER BY 
      CASE WHEN ? = 'date' AND ? = 'asc' THEN call_date END ASC,
      CASE WHEN ? = 'date' AND ? = 'desc' THEN call_date END DESC,
      CASE WHEN ? = 'time' AND ? = 'asc' THEN call_time END ASC,
      CASE WHEN ? = 'time' AND ? = 'desc' THEN call_time END DESC,
      CASE WHEN ? = 'phone' AND ? = 'asc' THEN phone END ASC,
      CASE WHEN ? = 'phone' AND ? = 'desc' THEN phone END DESC,
      CASE WHEN ? = 'email' AND ? = 'asc' THEN email END ASC,
      CASE WHEN ? = 'email' AND ? = 'desc' THEN email END DESC,
      CASE WHEN ? = 'durationMs' AND ? = 'asc' THEN duration_ms END ASC,
      CASE WHEN ? = 'durationMs' AND ? = 'desc' THEN duration_ms END DESC,
      call_date DESC, call_time DESC
    LIMIT ? OFFSET ?
  `),
  
  // Count total files matching filters
  countFiles: db.prepare(`
    SELECT COUNT(*) as total
    FROM files
    WHERE 1=1
      AND (? IS NULL OR call_date >= ?)
      AND (? IS NULL OR call_date <= ?)
      AND (? IS NULL OR phone LIKE '%' || ? || '%')
      AND (? IS NULL OR email LIKE '%' || ? || '%')
      AND (? IS NULL OR duration_ms >= ? * 1000)
      AND (? IS NULL OR call_time >= ?)
      AND (? IS NULL OR call_time <= ?)
  `),
  
  // Check if file exists
  fileExists: db.prepare('SELECT 1 FROM files WHERE file_path = ?'),
  
  // Delete file record
  deleteFile: db.prepare('DELETE FROM files WHERE file_path = ?'),
  
  // Get total file count
  getTotalCount: db.prepare('SELECT COUNT(*) as total FROM files'),
  
  // Get files by date range for indexing
  getFilesByDateRange: db.prepare(`
    SELECT file_path FROM files 
    WHERE call_date >= ? AND call_date <= ?
  `),
  
  // Audit logging statements
  createUserSession: db.prepare(`
    INSERT INTO user_sessions (user_id, user_email, ip_address, user_agent)
    VALUES (?, ?, ?, ?)
  `),
  
  updateUserSession: db.prepare(`
    UPDATE user_sessions 
    SET logout_time = CURRENT_TIMESTAMP, 
        session_duration_ms = (strftime('%s', 'now') - strftime('%s', login_time)) * 1000
    WHERE user_id = ? AND logout_time IS NULL
  `),
  
  createAuditLog: db.prepare(`
    INSERT INTO audit_logs (user_id, user_email, action_type, file_path, file_phone, file_email, 
                           ip_address, user_agent, session_id, additional_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  
  getAuditLogs: db.prepare(`
    SELECT * FROM audit_logs 
    WHERE (? IS NULL OR user_id = ?)
      AND (? IS NULL OR action_type = ?)
      AND (? IS NULL OR DATE(action_timestamp) >= ?)
      AND (? IS NULL OR DATE(action_timestamp) <= ?)
    ORDER BY action_timestamp DESC 
    LIMIT ? OFFSET ?
  `),
  
  getUserSessions: db.prepare(`
    SELECT * FROM user_sessions 
    WHERE (? IS NULL OR user_id = ?)
      AND (? IS NULL OR DATE(login_time) >= ?)
      AND (? IS NULL OR DATE(login_time) <= ?)
    ORDER BY login_time DESC 
    LIMIT ? OFFSET ?
  `),
  
  getLastLogin: db.prepare(`
    SELECT login_time FROM user_sessions 
    WHERE user_id = ? 
    ORDER BY login_time DESC 
    LIMIT 1
  `),

  // Distinct users from audit_logs and user_sessions for autocomplete
  getDistinctUsers: db.prepare(`
    SELECT user_id, user_email FROM (
      SELECT user_id, user_email FROM audit_logs
      UNION ALL
      SELECT user_id, user_email FROM user_sessions
    )
    WHERE (? IS NULL OR user_email LIKE '%' || ? || '%' OR user_id LIKE '%' || ? || '%')
    GROUP BY user_id, user_email
    ORDER BY user_email
    LIMIT ?
  `)
};

// Helper function to parse filename and extract metadata
export function parseFileMetadata(filePath) {
  const cleanFile = filePath.startsWith('recordings/') ? filePath.slice('recordings/'.length) : filePath;
  const [folder, filename] = cleanFile.split('/');
  
  if (!folder || !filename) return null;
  
  // Parse date from folder (M_D_YYYY -> YYYY-MM-DD)
  const dateParts = folder.split('_');
  if (dateParts.length !== 3) return null;
  
  const [month, day, year] = dateParts;
  const callDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  
  // Parse filename: {phone} by {email} @ {time}_{duration}.wav
  const phoneMatch = filename.match(/^(\d+)/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  
  const emailMatch = filename.match(/by ([^@]+@[^ ]+)/);
  const email = emailMatch ? emailMatch[1] : '';
  
  const timeMatch = filename.match(/@ ([\d_]+ [AP]M)/);
  const timeStr = timeMatch ? timeMatch[1].replace(/_/g, ':') : '';
  
  // Convert to 24-hour format for database storage
  let callTime = '';
  if (timeStr) {
    try {
      const parsed = new Date(`1970-01-01 ${timeStr}`);
      if (!isNaN(parsed.getTime())) {
        callTime = parsed.toTimeString().slice(0, 8); // HH:MM:SS
      }
    } catch (e) {
      console.warn('Failed to parse time:', timeStr);
    }
  }
  
  const durationMatch = filename.match(/_(\d+)\.wav$/);
  const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : 0;
  
  return {
    filePath,
    phone,
    email,
    callDate,
    callTime,
    durationMs,
    fileSize: 0 // Will be updated when available
  };
}

// Index a single file
export function indexFile(filePath, fileSize = 0) {
  const metadata = parseFileMetadata(filePath);
  if (!metadata) return false;
  
  try {
    statements.upsertFile.run(
      metadata.filePath,
      metadata.phone,
      metadata.email,
      metadata.callDate,
      metadata.callTime,
      metadata.durationMs,
      fileSize
    );
    return true;
  } catch (error) {
    console.error('Error indexing file:', filePath, error);
    return false;
  }
}

// Batch index multiple files (for initial indexing)
export function indexFiles(files) {
  const transaction = db.transaction((fileList) => {
    let indexed = 0;
    for (const file of fileList) {
      const filePath = typeof file === 'string' ? file : file.filePath;
      const fileSize = typeof file === 'object' ? file.fileSize : 0;
      
      if (indexFile(filePath, fileSize)) {
        indexed++;
      }
    }
    return indexed;
  });
  
  return transaction(files);
}

// Query files with advanced filtering and pagination
export function queryFiles(filters = {}) {
  const {
    dateStart,
    dateEnd,
    phone,
    email,
    durationMin,
    timeStart,
    timeEnd,
    sortColumn = 'date',
    sortDirection = 'desc',
    limit = 25,
    offset = 0
  } = filters;
  
  // Convert date formats if needed
  const startDate = dateStart ? convertDateFormat(dateStart) : null;
  const endDate = dateEnd ? convertDateFormat(dateEnd) : null;
  
  // Prepare parameters for the query (in order of ? placeholders)
  const queryParams = [
    startDate, startDate,  // dateStart check (2 params)
    endDate, endDate,      // dateEnd check (2 params)
    phone, phone,          // phone filter (2 params)
    email, email,          // email filter (2 params)
    durationMin, durationMin, // duration filter (2 params)
    timeStart, timeStart,  // timeStart filter (2 params)
    timeEnd, timeEnd,      // timeEnd filter (2 params)
    // Sorting parameters (multiple for different combinations)
    sortColumn, sortDirection, // date sort
    sortColumn, sortDirection, // date sort desc
    sortColumn, sortDirection, // time sort
    sortColumn, sortDirection, // time sort desc
    sortColumn, sortDirection, // phone sort
    sortColumn, sortDirection, // phone sort desc
    sortColumn, sortDirection, // email sort
    sortColumn, sortDirection, // email sort desc
    sortColumn, sortDirection, // duration sort
    sortColumn, sortDirection, // duration sort desc
    limit, offset
  ];
  
  const files = statements.getFiles.all(...queryParams);
  
  // Get total count with same filters
  const countParams = [
    startDate, startDate,
    endDate, endDate,
    phone, phone,
    email, email,
    durationMin, durationMin,
    timeStart, timeStart,
    timeEnd, timeEnd
  ];
  
  const { total } = statements.countFiles.get(...countParams);
  
  return {
    files,
    totalCount: total,
    hasMore: offset + limit < total
  };
}

// Helper function to convert M_D_YYYY to YYYY-MM-DD
function convertDateFormat(dateStr) {
  if (!dateStr) return null;
  
  if (dateStr.includes('_')) {
    // Convert M_D_YYYY to YYYY-MM-DD
    const [month, day, year] = dateStr.split('_');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  return dateStr; // Already in correct format
}

// Check database stats
export function getDatabaseStats() {
  try {
    const { total } = statements.getTotalCount.get();
    const databaseSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
    
    return {
      totalFiles: total || 0,
      databasePath: DB_PATH,
      databaseSize: databaseSize
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    return {
      totalFiles: 0,
      databasePath: DB_PATH,
      databaseSize: 0
    };
  }
}

// Audit logging functions
export function logUserSession(userId, userEmail, ipAddress, userAgent) {
  try {
    const result = statements.createUserSession.run(userId, userEmail, ipAddress, userAgent);
    console.log(`📋 [AUDIT] User session created for ${userEmail} (ID: ${userId})`);
    return result.lastInsertRowid;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
  }
}

export function logUserLogout(userId) {
  try {
    statements.updateUserSession.run(userId);
    console.log(`📋 [AUDIT] User session ended for ${userId}`);
  } catch (error) {
    console.error('Error updating user session:', error);
  }
}

export function logAuditEvent(userId, userEmail, actionType, filePath = null, fileMetadata = null, ipAddress = null, userAgent = null, sessionId = null, additionalData = null) {
  try {
    const filePhone = fileMetadata?.phone || null;
    const fileEmail = fileMetadata?.email || null;
    const additionalDataStr = additionalData ? JSON.stringify(additionalData) : null;
    
    statements.createAuditLog.run(
      userId, 
      userEmail, 
      actionType, 
      filePath, 
      filePhone, 
      fileEmail, 
      ipAddress, 
      userAgent, 
      sessionId, 
      additionalDataStr
    );
    
    console.log(`📋 [AUDIT] ${actionType} logged for ${userEmail}${filePath ? ` - File: ${filePath}` : ''}`);
  } catch (error) {
    console.error('Error creating audit log:', error);
  }
}

export function getAuditLogs(userId = null, actionType = null, startDate = null, endDate = null, limit = 100, offset = 0) {
  try {
    return statements.getAuditLogs.all(
      userId, userId,
      actionType, actionType,
      startDate, startDate,
      endDate, endDate,
      limit, offset
    );
  } catch (error) {
    console.error('Error getting audit logs:', error);
    return [];
  }
}

export function getUserSessions(userId = null, startDate = null, endDate = null, limit = 100, offset = 0) {
  try {
    return statements.getUserSessions.all(
      userId, userId,
      startDate, startDate,
      endDate, endDate,
      limit, offset
    );
  } catch (error) {
    console.error('Error getting user sessions:', error);
    return [];
  }
}

export function getLastLogin(userId) {
  try {
    const result = statements.getLastLogin.get(userId);
    return result?.login_time || null;
  } catch (error) {
    console.error('Error getting last login:', error);
    return null;
  }
}

export function getDistinctUsers(search = null, limit = 20) {
  try {
    const term = search && search.trim() !== '' ? search.trim() : null;
    return statements.getDistinctUsers.all(term, term, term, limit);
  } catch (error) {
    console.error('Error getting distinct users:', error);
    return [];
  }
}

export { db, statements };
export default db;
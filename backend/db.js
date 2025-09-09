import Database from 'better-sqlite3';
const db = new Database('/root/db/recbot.db'); // Use this path inside the container

export default db;
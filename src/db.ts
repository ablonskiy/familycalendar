import Database from 'better-sqlite3';

const db = new Database('bot_data.db');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    user_email TEXT PRIMARY KEY,
    tokens TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    chat_id INTEGER PRIMARY KEY,
    state TEXT,
    data TEXT
  );
`);

export default db;

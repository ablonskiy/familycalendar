import db from './src/db.js';

try {
  const tokens = db.prepare('SELECT * FROM google_tokens').all();
  console.log('Google Tokens Rows:', JSON.stringify(tokens));
  
  const sessions = db.prepare('SELECT * FROM sessions').all();
  console.log('Sessions:', sessions.length);
} catch (e) {
  console.error('DB Check failed:', e);
}

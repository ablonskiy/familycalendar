import { google } from 'googleapis';
import db from '../db';

function getOAuthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth credentials missing in environment variables');
  }
  
  // Ensure APP_URL doesn't have a trailing slash before appending /auth/callback
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const redirectUri = `${baseUrl}/auth/callback`;
  
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  // Listen for token refreshes and save them to the DB
  client.on('tokens', (tokens) => {
    console.log('Google tokens refreshed, saving to DB...');
    const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
    if (row) {
      const currentTokens = JSON.parse(row.tokens);
      const updatedTokens = { ...currentTokens, ...tokens };
      db.prepare('UPDATE google_tokens SET tokens = ? WHERE user_email = ?')
        .run(JSON.stringify(updatedTokens), 'primary');
    }
  });

  return client;
}

export function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    prompt: 'consent'
  });
}

export async function setTokens(code: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  
  // Store tokens in DB (for simplicity we use a single global account for the family bot)
  db.prepare('INSERT OR REPLACE INTO google_tokens (user_email, tokens) VALUES (?, ?)')
    .run('primary', JSON.stringify(tokens));
  
  return tokens;
}

export async function addCalendarEvent(eventData: any) {
  const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
  if (!row) throw new Error('Google Calendar not connected. Please connect via dashboard.');

  const client = getOAuthClient();
  const tokens = JSON.parse(row.tokens);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });

  // Get selected calendar ID from settings, fallback to 'primary'
  const calendarSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('calendar_id') as any;
  const calendarId = calendarSetting ? calendarSetting.value : 'primary';

  // Helper to validate and fix timezone
  const getValidTz = (input: string) => {
    const clean = input.replace(/['"]/g, '').trim();
    const mapping: Record<string, string> = {
      'Belgrade': 'Europe/Belgrade',
      'Moscow': 'Europe/Moscow',
      'London': 'Europe/London',
      'Paris': 'Europe/Paris',
      'Berlin': 'Europe/Berlin',
      'Kiev': 'Europe/Kiev',
      'Kyiv': 'Europe/Kiev',
      'Dubai': 'Asia/Dubai',
    };
    if (mapping[clean]) return mapping[clean];
    try {
      Intl.DateTimeFormat(undefined, { timeZone: clean });
      return clean;
    } catch (e) {
      return 'UTC';
    }
  };

  const tz = getValidTz(process.env.TIMEZONE || 'Europe/Moscow');

  // We send the date and time string directly without 'Z' 
  // and specify the timeZone so Google interprets it correctly in the user's local time.
  const startDateTime = `${eventData.date}T${eventData.time}:00`;
  
  // Calculate end time safely by treating input as UTC for the duration math, 
  // then stripping the 'Z' back off.
  const startDate = new Date(`${startDateTime}Z`);
  const endDate = new Date(startDate.getTime() + eventData.durationMinutes * 60000);
  const endDateTime = endDate.toISOString().split('.')[0].replace('Z', '');

  const event = {
    summary: eventData.title,
    location: eventData.location,
    description: eventData.description,
    start: {
      dateTime: startDateTime,
      timeZone: tz,
    },
    end: {
      dateTime: endDateTime,
      timeZone: tz,
    },
  };

  const res = await calendar.events.insert({
    calendarId: calendarId,
    requestBody: event,
  });

  return res.data;
}

export async function getEvents(startDate: string, endDate: string) {
  const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
  if (!row) throw new Error('Google Calendar not connected');

  const client = getOAuthClient();
  const tokens = JSON.parse(row.tokens);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });
  
  // Get selected calendar ID from settings, fallback to 'primary'
  const calendarSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('calendar_id') as any;
  const calendarId = calendarSetting ? calendarSetting.value : 'primary';

  const res = await calendar.events.list({
    calendarId: calendarId,
    timeMin: `${startDate}T00:00:00Z`,
    timeMax: `${endDate}T23:59:59Z`,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

export async function listCalendars() {
  const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
  if (!row) throw new Error('Google Calendar not connected');

  const client = getOAuthClient();
  const tokens = JSON.parse(row.tokens);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.calendarList.list();
  const items = res.data.items || [];
  console.log(`Found ${items.length} calendars for user`);
  return items;
}

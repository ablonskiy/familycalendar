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

export async function getCalendarTimezone(): Promise<string> {
  const row = db.prepare('SELECT tokens FROM google_tokens WHERE user_email = ?').get('primary') as any;
  if (!row) return 'Europe/Belgrade';

  const client = getOAuthClient();
  const tokens = JSON.parse(row.tokens);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });
  const calendarSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('calendar_id') as any;
  const calendarId = calendarSetting ? calendarSetting.value : 'primary';

  try {
    const res = await calendar.calendars.get({ calendarId });
    const tz = res.data.timeZone;
    if (tz) {
      console.log(`Calendar timezone: ${tz}`);
      return tz;
    }
  } catch (e) {
    console.error('Failed to get calendar timezone, falling back to Europe/Belgrade:', e);
  }
  return 'Europe/Belgrade';
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

  // Read timezone directly from Google Calendar — no env var needed
  const calInfo = await calendar.calendars.get({ calendarId });
  const tz = calInfo.data.timeZone || 'Europe/Belgrade';
  console.log(`Using calendar timezone for event: ${tz}`);

  // Build start datetime as a naive local time string
  const startDateTime = `${eventData.date}T${eventData.time}:00`;

  // Calculate end time via direct arithmetic on local time (avoids UTC conversion bugs)
  const [h, m] = eventData.time.split(':').map(Number);
  const totalMins = h * 60 + m + eventData.durationMinutes;
  const endH = Math.floor(totalMins / 60) % 24;
  const endM = totalMins % 60;
  let endDateStr = eventData.date;
  if (totalMins >= 24 * 60) {
    const d = new Date(`${eventData.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Math.floor(totalMins / (24 * 60)));
    endDateStr = d.toISOString().split('T')[0];
  }
  const endDateTime = `${endDateStr}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;

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

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const helmet = require('helmet');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', 'loopback');
const port = Number(process.env.PORT || 3000);
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'attendance');
const sessionSecret = process.env.SESSION_SECRET;
const defaultEventName = 'Agile in Africa 2026';
// Check-in days roll over at midnight in the event's local time, not the server's.
const eventTimeZone = process.env.EVENT_TIMEZONE || 'Africa/Accra';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dashboardClients = new Map();
let db;

const pendingDashboardUpdates = new Set();

// Each update makes every open dashboard reload the full guest list, so a burst of
// check-ins at the door is coalesced into at most one update per second per admin.
function notifyDashboard(adminId) {
  if (pendingDashboardUpdates.has(adminId)) return;
  pendingDashboardUpdates.add(adminId);
  setTimeout(() => {
    pendingDashboardUpdates.delete(adminId);
    const clients = dashboardClients.get(adminId);
    if (!clients) return;
    for (const response of clients) {
      if (!response.writableEnded) response.write('event: dashboard-update\ndata: {}\n\n');
    }
  }, 1000).unref();
}

if (!sessionSecret || sessionSecret.length < 32 || sessionSecret === 'replace-this-with-a-long-random-secret') {
  throw new Error('Set SESSION_SECRET to a random value at least 32 characters long.');
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(session({
  store: new (class extends session.Store {
    get(sid, callback) {
      db.query('SELECT sess FROM app_sessions WHERE sid = $1 AND expire > now()', [sid])
        .then(({ rows }) => callback(null, rows[0]?.sess || null), callback);
    }

    set(sid, sess, callback = () => {}) {
      const expiresAt = sess.cookie?.expires || new Date(Date.now() + (sess.cookie?.maxAge || 12 * 60 * 60 * 1000));
      db.query(
        `INSERT INTO app_sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify(sess), expiresAt]
      ).then(() => callback(null), callback);
    }

    destroy(sid, callback = () => {}) {
      db.query('DELETE FROM app_sessions WHERE sid = $1', [sid]).then(() => callback(null), callback);
    }

    touch(sid, sess, callback = () => {}) {
      const expiresAt = sess.cookie?.expires || new Date(Date.now() + (sess.cookie?.maxAge || 12 * 60 * 60 * 1000));
      db.query('UPDATE app_sessions SET expire = $2 WHERE sid = $1', [sid, expiresAt]).then(() => callback(null), callback);
    }
  })(),
  name: 'gather.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

// Only failed sign-ins count, so several staff can sign in from the same venue network.
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' }
});
// Guests on venue Wi-Fi or carrier NAT share one public IP, and a guest can need 2-5 requests
// (search, retry, register, check in), so this allows a crowded entrance while still slowing automated name guessing.
// Four-digit codes are guessable, so failed code searches on the public page are limited separately:
// a guest who mistypes is unaffected, but stepping through codes to read guests' details is cut off.
const codeMissLimit = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 100, skipSuccessfulRequests: true, standardHeaders: false, legacyHeaders: false,
  skip: (req) => !codePattern.test(text(req.body?.query ?? req.body?.name, 120).replace(/\s+/g, '')),
  message: { error: 'Too many incorrect codes. Please search by your full name, or ask the event team for help.' }
});
const lookupLimit = rateLimit({
  windowMs: 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'The check-in desk is very busy. Please wait a minute and try again.' }
});

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}

function text(value, maxLength = 180) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function attendeeFields(body) {
  const fields = {
    name: text(body.name, 120),
    phone: text(body.phone, 40),
    email: text(body.email, 180),
    company: text(body.company, 120),
    profession: text(body.profession, 120),
    notes: text(body.notes, 1000)
  };
  if (!fields.name || !fields.email || !fields.phone || !fields.company) {
    return { error: 'Full name, email, phone, and organisation are required.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return { error: 'Enter a valid email address.' };
  }
  return { fields };
}

// Four random digits (1000-9999, never sequential) are easy to say at the desk and type on any keypad.
// 9000 codes per event leaves plenty of room for retries to find a free one at conference scale.
const codePattern = /^\d{4}$/;
const maxCodeAttempts = 20;

function newCheckinCode() {
  return String(crypto.randomInt(1000, 10000));
}

async function insertAttendee(adminId, fields, returning) {
  // The only unique constraint a new attendee can hit is (admin_id, code), so a clash just means drawing another code.
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.query(
        `INSERT INTO attendees (admin_id, code, name, phone, email, company, profession, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${returning}`,
        [adminId, newCheckinCode(), fields.name, fields.phone, fields.email, fields.company, fields.profession, fields.notes]
      );
    } catch (error) {
      if (error.code !== '23505' || attempt === maxCodeAttempts) throw error;
    }
  }
}

async function checkInToday(attendeeId, adminId) {
  // The unique (attendee, day) constraint makes a repeat check-in on the same day a no-op.
  const inserted = await db.query(
    `INSERT INTO checkins (attendee_id, admin_id, checkin_date) VALUES ($1, $2, (now() AT TIME ZONE $3)::date)
     ON CONFLICT (attendee_id, checkin_date) DO NOTHING
     RETURNING checked_in_at`,
    [attendeeId, adminId, eventTimeZone]
  );
  if (inserted.rowCount) {
    notifyDashboard(adminId);
    return { checkedInAt: inserted.rows[0].checked_in_at, alreadyCheckedIn: false };
  }
  const existing = await db.query(
    'SELECT checked_in_at FROM checkins WHERE attendee_id = $1 AND checkin_date = (now() AT TIME ZONE $2)::date',
    [attendeeId, eventTimeZone]
  );
  return { checkedInAt: existing.rows[0].checked_in_at, alreadyCheckedIn: true };
}

function adminView(row) {
  return { id: row.id, name: row.name, email: row.email, eventName: row.event_name, publicToken: row.public_token };
}

app.get('/api/auth/session', async (req, res, next) => {
  try {
    if (!req.session.adminId) return res.json({ admin: null });
    const result = await db.query('SELECT id, name, email, event_name, public_token FROM admins WHERE id = $1', [req.session.adminId]);
    if (!result.rowCount) {
      req.session.destroy(() => {});
      return res.json({ admin: null });
    }
    res.json({ admin: adminView(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', authLimit, async (req, res, next) => {
  const name = text(req.body.name, 120);
  const email = text(req.body.email, 180).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const eventName = text(req.body.eventName, 160) || defaultEventName;
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
    return res.status(400).json({ error: 'Enter your name, a valid email, and a password of at least 10 characters.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO admins (name, email, password_hash, event_name, public_token) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, event_name, public_token',
      [name, email, passwordHash, eventName, crypto.randomUUID()]
    );
    req.session.adminId = result.rows[0].id;
    res.status(201).json({ admin: adminView(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    next(error);
  }
});

app.post('/api/auth/login', authLimit, async (req, res, next) => {
  const email = text(req.body.email, 180).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  try {
    const result = await db.query('SELECT * FROM admins WHERE email = $1', [email]);
    const admin = result.rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.adminId = admin.id;
      res.json({ admin: adminView(admin) });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAdmin, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('gather.sid', { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

app.get('/api/dashboard', requireAdmin, async (req, res, next) => {
  try {
    const [today, attendees] = await Promise.all([
      db.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`, [eventTimeZone]),
      db.query(
        `SELECT a.id, a.code, a.name, a.phone, a.email, a.company, a.profession, a.notes, a.created_at,
           COALESCE(json_agg(json_build_object('date', to_char(c.checkin_date, 'YYYY-MM-DD'), 'checkedInAt', c.checked_in_at)
             ORDER BY c.checkin_date) FILTER (WHERE c.id IS NOT NULL), '[]') AS checkins
         FROM attendees a LEFT JOIN checkins c ON c.attendee_id = a.id
         WHERE a.admin_id = $1
         GROUP BY a.id
         ORDER BY a.created_at DESC`,
        [req.session.adminId]
      )
    ]);
    res.json({ today: today.rows[0].today, attendees: attendees.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/events', requireAdmin, (req, res) => {
  const adminId = req.session.adminId;
  res.set({
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  if (!dashboardClients.has(adminId)) dashboardClients.set(adminId, new Set());
  const clients = dashboardClients.get(adminId);
  clients.add(res);

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) dashboardClients.delete(adminId);
  });
});

app.patch('/api/event', requireAdmin, async (req, res, next) => {
  const eventName = text(req.body.eventName, 160);
  if (!eventName) return res.status(400).json({ error: 'Enter an event name.' });
  try {
    const result = await db.query('UPDATE admins SET event_name = $1 WHERE id = $2 RETURNING id, name, email, event_name, public_token', [eventName, req.session.adminId]);
    notifyDashboard(req.session.adminId);
    res.json({ admin: adminView(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qr', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('SELECT public_token FROM admins WHERE id = $1', [req.session.adminId]);
    const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const url = `${baseUrl}/checkin/${result.rows[0].public_token}`;
    res.json({ url, image: await QRCode.toDataURL(url, { width: 480, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#1d8a3d', light: '#ffffff' } }) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/attendees', requireAdmin, async (req, res, next) => {
  const { fields, error } = attendeeFields(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const result = await insertAttendee(req.session.adminId, fields, 'id, admin_id, code, name, phone, email, company, profession, notes, created_at');
    notifyDashboard(req.session.adminId);
    res.status(201).json({ attendee: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.put('/api/attendees/:id', requireAdmin, async (req, res, next) => {
  const { fields, error } = attendeeFields(req.body);
  if (error) return res.status(400).json({ error });
  if (!uuidPattern.test(req.params.id)) return res.status(404).json({ error: 'Attendee not found.' });
  try {
    const result = await db.query(
      'UPDATE attendees SET name = $1, phone = $2, email = $3, company = $4, profession = $5, notes = $6 WHERE id = $7 AND admin_id = $8 RETURNING id, admin_id, code, name, phone, email, company, profession, notes, created_at',
      [fields.name, fields.phone, fields.email, fields.company, fields.profession, fields.notes, req.params.id, req.session.adminId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Attendee not found.' });
    notifyDashboard(req.session.adminId);
    res.json({ attendee: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get('/api/attendees/code/:code', requireAdmin, async (req, res, next) => {
  const code = text(req.params.code, 20).replace(/\s+/g, '');
  if (!codePattern.test(code)) return res.status(400).json({ error: 'Check-in codes are 4 digits.' });
  try {
    const result = await db.query(
      `SELECT a.id, a.code, a.name, a.phone, a.email, a.company, a.profession, a.notes, c.checked_in_at AS checked_in_today
       FROM attendees a
       LEFT JOIN checkins c ON c.attendee_id = a.id AND c.checkin_date = (now() AT TIME ZONE $3)::date
       WHERE a.admin_id = $1 AND a.code = $2`,
      [req.session.adminId, code, eventTimeZone]
    );
    if (!result.rowCount) return res.status(404).json({ error: `No guest has the code ${code}. Check the digits with the guest.` });
    res.json({ attendee: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/attendees/:id/checkin', requireAdmin, async (req, res, next) => {
  if (!uuidPattern.test(req.params.id)) return res.status(404).json({ error: 'Attendee not found.' });
  try {
    const owned = await db.query('SELECT id FROM attendees WHERE id = $1 AND admin_id = $2', [req.params.id, req.session.adminId]);
    if (!owned.rowCount) return res.status(404).json({ error: 'Attendee not found.' });
    const { checkedInAt, alreadyCheckedIn } = await checkInToday(req.params.id, req.session.adminId);
    res.json({ checkedInAt, alreadyCheckedIn });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/attendees/:id', requireAdmin, async (req, res, next) => {
  if (!uuidPattern.test(req.params.id)) return res.status(404).json({ error: 'Attendee not found.' });
  try {
    const result = await db.query('DELETE FROM attendees WHERE id = $1 AND admin_id = $2', [req.params.id, req.session.adminId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Attendee not found.' });
    notifyDashboard(req.session.adminId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/public/:token', async (req, res, next) => {
  try {
    const result = await db.query('SELECT event_name FROM admins WHERE public_token = $1', [req.params.token]);
    if (!result.rowCount) return res.status(404).json({ error: 'This check-in link is invalid.' });
    res.json({ eventName: result.rows[0].event_name });
  } catch (error) {
    next(error);
  }
});

app.post('/api/public/:token/register', lookupLimit, async (req, res, next) => {
  const { fields, error } = attendeeFields(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const admin = await db.query('SELECT id FROM admins WHERE public_token = $1', [req.params.token]);
    if (!admin.rowCount) return res.status(404).json({ error: 'This check-in link is invalid.' });
    const result = await insertAttendee(admin.rows[0].id, fields, 'id, code, name, phone, email, company, profession, notes');
    notifyDashboard(admin.rows[0].id);
    res.status(201).json({ attendee: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post('/api/public/:token/find', lookupLimit, codeMissLimit, async (req, res, next) => {
  // Guests can type either their full name or their 4-digit check-in code (`name` is accepted from older pages).
  const query = text(req.body.query ?? req.body.name, 120);
  if (!query) return res.status(400).json({ error: 'Enter your full name or check-in code.' });
  const code = query.replace(/\s+/g, '');
  const byCode = codePattern.test(code);
  try {
    const result = await db.query(
      `SELECT a.id, a.code, a.name, a.phone, a.email, a.company, a.profession, a.notes, c.checked_in_at AS checked_in_today
       FROM attendees a JOIN admins d ON d.id = a.admin_id
       LEFT JOIN checkins c ON c.attendee_id = a.id AND c.checkin_date = (now() AT TIME ZONE $3)::date
       WHERE d.public_token = $1 AND ${byCode ? 'a.code = $2' : 'lower(a.name) = lower($2)'}
       ORDER BY a.created_at`,
      [req.params.token, byCode ? code : query, eventTimeZone]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: byCode
        ? 'No registration found with that code. Check the digits, try your full name, or ask the event team for help.'
        : 'No registration found with that exact name. Check the spelling, try your check-in code, or ask the event team for help.' });
    }
    res.json({ attendees: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/public/:token/attend', lookupLimit, async (req, res, next) => {
  const attendeeId = text(req.body.attendeeId, 40);
  if (!uuidPattern.test(attendeeId)) return res.status(404).json({ error: 'Registration not found. Search your name again.' });
  try {
    const attendee = await db.query(
      `SELECT a.id, a.admin_id, a.code, a.name, a.phone, a.email, a.company, a.profession, a.notes
       FROM attendees a JOIN admins d ON d.id = a.admin_id
       WHERE d.public_token = $1 AND a.id = $2`,
      [req.params.token, attendeeId]
    );
    if (!attendee.rowCount) {
      return res.status(404).json({ error: 'Registration not found. Search your name again.' });
    }
    const { admin_id: adminId, ...details } = attendee.rows[0];
    const { checkedInAt, alreadyCheckedIn } = await checkInToday(attendeeId, adminId);
    res.json({ attendee: { ...details, checked_in_today: checkedInAt }, alreadyCheckedIn });
  } catch (error) {
    next(error);
  }
});

app.get('/checkin/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  db = await PGlite.create(databasePath);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      event_name text NOT NULL,
      public_token uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS attendees (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      name text NOT NULL,
      phone text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      company text NOT NULL DEFAULT '',
      profession text NOT NULL DEFAULT '',
      notes text NOT NULL DEFAULT '',
      attended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS attendees_admin_created_idx ON attendees (admin_id, created_at DESC);
    ALTER TABLE attendees ADD COLUMN IF NOT EXISTS code text;
    CREATE UNIQUE INDEX IF NOT EXISTS attendees_admin_code_idx ON attendees (admin_id, code);
    CREATE TABLE IF NOT EXISTS checkins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      attendee_id uuid NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
      admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      checkin_date date NOT NULL,
      checked_in_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attendee_id, checkin_date)
    );
    CREATE INDEX IF NOT EXISTS checkins_admin_date_idx ON checkins (admin_id, checkin_date);
    CREATE TABLE IF NOT EXISTS app_sessions (
      sid text PRIMARY KEY,
      sess jsonb NOT NULL,
      expire timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_sessions_expire_idx ON app_sessions (expire);
  `);
  await db.query('SELECT now() AT TIME ZONE $1', [eventTimeZone]).catch(() => {
    throw new Error(`EVENT_TIMEZONE "${eventTimeZone}" is not a recognised time zone.`);
  });
  // Give guests registered before 4-digit codes existed (no code, or an older 6-digit one) a code of their own.
  const uncoded = await db.query(`SELECT id FROM attendees WHERE code IS NULL OR code !~ '^[0-9]{4}$'`);
  for (const { id } of uncoded.rows) {
    for (let attempt = 1; ; attempt++) {
      try {
        await db.query('UPDATE attendees SET code = $1 WHERE id = $2', [newCheckinCode(), id]);
        break;
      } catch (error) {
        if (error.code !== '23505' || attempt === maxCodeAttempts) throw error;
      }
    }
  }
  // One-time move of single check-ins (attendees.attended_at) into the per-day checkins table.
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO checkins (attendee_id, admin_id, checkin_date, checked_in_at)
       SELECT id, admin_id, (attended_at AT TIME ZONE $1)::date, attended_at FROM attendees WHERE attended_at IS NOT NULL
       ON CONFLICT (attendee_id, checkin_date) DO NOTHING`,
      [eventTimeZone]
    );
    await tx.query('UPDATE attendees SET attended_at = NULL WHERE attended_at IS NOT NULL');
  });
  setInterval(() => db.query('DELETE FROM app_sessions WHERE expire <= now()').catch(console.error), 60 * 60 * 1000).unref();
  const server = app.listen(port, () => console.log(`Gather is running at http://localhost:${port}`));
  const shutdown = () => {
    for (const clients of dashboardClients.values()) {
      for (const response of clients) response.end();
    }
    dashboardClients.clear();
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    // Keep-alive sockets (from Caddy or a closed dashboard stream) would otherwise hold close() open
    // until systemd kills the process mid-write; give in-flight requests a moment, then drop the rest.
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('Could not start the app. Check the local database directory is writable:', error.message);
  process.exit(1);
});
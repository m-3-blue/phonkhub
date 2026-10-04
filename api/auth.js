import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { serialize, parse } from 'cookie';
import crypto from 'crypto';

const SESSION_COOKIE = 'ph_session';
const SESSION_DAYS = 30;

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function now() {
  return new Date().toISOString();
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function setSessionCookie(res, token, expiresAt) {
  res.setHeader('Set-Cookie', serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  }));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serialize(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  }));
}

function getSessionToken(req) {
  const cookies = parse(req.headers.cookie || '');
  return cookies[SESSION_COOKIE] || null;
}

export default async function handler(req, res) {
  const action = req.query.action;
  const client = getClient();

  try {
    // -------- SIGNUP --------
    if (action === 'signup' && req.method === 'POST') {
      const { username, email, password } = req.body || {};

      if (!isValidUsername(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters, letters/numbers/underscores only' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      // Check if username or email is taken
      const existing = await client.execute({
        sql: 'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
        args: [username, email],
      });
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.username.toLowerCase() === username.toLowerCase()) {
          return res.status(409).json({ error: 'Username already taken' });
        }
        return res.status(409).json({ error: 'Email already registered' });
      }

      const hash = await bcrypt.hash(password, 10);

      const result = await client.execute({
        sql: 'INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
        args: [username, email, hash, now()],
      });

      const userId = Number(result.lastInsertRowid);

      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = daysFromNow(SESSION_DAYS);
      await client.execute({
        sql: 'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        args: [token, userId, now(), expiresAt],
      });

      setSessionCookie(res, token, expiresAt);
      return res.status(200).json({
        user: { id: userId, username },
      });
    }

    // -------- LOGIN --------
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ error: 'Missing username or password' });
      }

      // Allow login with username OR email
      const result = await client.execute({
        sql: 'SELECT id, username, password_hash FROM users WHERE username = ? OR email = ?',
        args: [username, username],
      });

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const user = result.rows[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = daysFromNow(SESSION_DAYS);
      await client.execute({
        sql: 'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        args: [token, user.id, now(), expiresAt],
      });

      setSessionCookie(res, token, expiresAt);
      return res.status(200).json({
        user: { id: user.id, username: user.username },
      });
    }

    // -------- LOGOUT --------
    if (action === 'logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) {
        await client.execute({
          sql: 'DELETE FROM sessions WHERE token = ?',
          args: [token],
        });
      }
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // -------- ME (who am I) --------
    if (action === 'me' && req.method === 'GET') {
      const token = getSessionToken(req);
      if (!token) {
        return res.status(200).json({ user: null });
      }

      const result = await client.execute({
        sql: `SELECT u.id, u.username, s.expires_at
              FROM sessions s
              JOIN users u ON u.id = s.user_id
              WHERE s.token = ?`,
        args: [token],
      });

      if (result.rows.length === 0) {
        clearSessionCookie(res);
        return res.status(200).json({ user: null });
      }

      const row = result.rows[0];

      // Expired?
      if (new Date(row.expires_at) < new Date()) {
        await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
        clearSessionCookie(res);
        return res.status(200).json({ user: null });
      }

      return res.status(200).json({
        user: { id: row.id, username: row.username },
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
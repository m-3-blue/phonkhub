import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
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

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  if (typeof req.headers['x-real-ip'] === 'string') {
    return req.headers['x-real-ip'];
  }
  if (req.socket && req.socket.remoteAddress) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
}

async function isIpBanned(client, ip) {
  if (!ip || ip === 'unknown') return false;
  var result = await client.execute({
    sql: 'SELECT 1 FROM banned_ips WHERE ip = ?',
    args: [ip],
  });
  return result.rows.length > 0;
}

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function setSessionCookie(res, token, expiresAt) {
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=' + token +
    '; Path=/; HttpOnly; SameSite=Lax; Expires=' + new Date(expiresAt).toUTCString()
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  );
}

function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) {
      return rest.join('=') || null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  const action = req.query.action;
  const client = getClient();
  const ip = getClientIp(req);

  try {
    // -------- SIGNUP --------
    if (action === 'signup' && req.method === 'POST') {
      if (await isIpBanned(client, ip)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { username, email, password, display_name } = req.body || {};

      if (!isValidUsername(username)) {
        return res.status(400).json({ error: 'Username must be 3-20 characters, letters/numbers/underscores only' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

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

      const finalDisplayName = (typeof display_name === 'string' && display_name.trim())
        ? display_name.trim().slice(0, 40)
        : username;

      const result = await client.execute({
        sql: 'INSERT INTO users (username, email, password_hash, display_name, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [username, email, hash, finalDisplayName, ip, now()],
      });

      const userId = Number(result.lastInsertRowid);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = daysFromNow(SESSION_DAYS);
      await client.execute({
        sql: 'INSERT INTO sessions (token, user_id, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        args: [token, userId, ip, now(), expiresAt],
      });

      setSessionCookie(res, token, expiresAt);
      return res.status(200).json({
        user: { id: userId, username, display_name: finalDisplayName },
      });
    }

    // -------- LOGIN --------
    if (action === 'login' && req.method === 'POST') {
      if (await isIpBanned(client, ip)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { username, password } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ error: 'Missing username or password' });
      }

      const result = await client.execute({
        sql: 'SELECT id, username, display_name, password_hash FROM users WHERE username = ? OR email = ?',
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

      await client.execute({
        sql: 'UPDATE users SET ip = ? WHERE id = ?',
        args: [ip, user.id],
      });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = daysFromNow(SESSION_DAYS);
      await client.execute({
        sql: 'INSERT INTO sessions (token, user_id, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        args: [token, user.id, ip, now(), expiresAt],
      });

      setSessionCookie(res, token, expiresAt);
      return res.status(200).json({
        user: { id: user.id, username: user.username, display_name: user.display_name || user.username },
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

    // -------- ME --------
    if (action === 'me' && req.method === 'GET') {
      const token = getSessionToken(req);
      if (!token) {
        return res.status(200).json({ user: null });
      }

      const result = await client.execute({
        sql: `SELECT u.id, u.username, u.display_name, s.expires_at
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

      if (new Date(row.expires_at) < new Date()) {
        await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
        clearSessionCookie(res);
        return res.status(200).json({ user: null });
      }

      return res.status(200).json({
        user: { id: row.id, username: row.username, display_name: row.display_name || row.username },
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SESSION_COOKIE = 'ph_session';
const SESSION_DAYS = 30;
const signupAttempts = new Map();
const RATE_LIMIT_MAX = 3; // Max 3 signups per IP
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

async function verifyTurnstile(token) {
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.TURNSTILE_SECRET_KEY}&response=${token}`
    });
    const data = await res.json();
    return data.success;
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return false;
  }
}

function setSessionCookie(req, res, token, expiresAt) {
  const isLocalhost = req.headers.host && (req.headers.host.includes('localhost') || req.headers.host.includes('127.0.0.1'));
  const secureFlag = isLocalhost ? '; SameSite=Lax' : '; Secure; SameSite=None';

  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=' + token +
    '; Path=/; HttpOnly' + secureFlag + '; Expires=' + new Date(expiresAt).toUTCString()
  );
}

function getSessionToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

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

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0'
  );
}

export default async function handler(req, res) {
  // 1. THE NEW, BULLETPROOF CORS SETUP
  const origin = req.headers.origin;
  
  if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1') || origin === 'capacitor://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (origin && ['https://o-phonkhub.vercel.app', 'https://phonkhub.vercel.app'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;
  const client = getClient();
  const ip = getClientIp(req);

  try {
    // --- CHECK LOCKDOWN ---
    const lockCheck = await client.execute("SELECT value FROM site_settings WHERE key = 'lockdown'");
    if (lockCheck.rows.length > 0 && lockCheck.rows[0].value === '1') {
      if (action !== 'me' && action !== 'logout') {
        return res.status(403).json({ error: 'PhonkHub is currently in lockdown. Try again later.' });
      }
    }

    if (action === 'signup' && req.method === 'POST') {
      if (await isIpBanned(client, ip)) return res.status(403).json({ error: 'Access denied' });

      // --- RATE LIMITING CHECK ---
      const nowTs = Date.now();
      const attempts = signupAttempts.get(ip) || { count: 0, firstAttempt: nowTs };
      
      if (nowTs - attempts.firstAttempt > RATE_LIMIT_WINDOW) {
        attempts.count = 0;
        attempts.firstAttempt = nowTs;
      }
      
      if (attempts.count >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many accounts created from this IP. Try again in an hour.' });
      }
      
      attempts.count++;
      signupAttempts.set(ip, attempts);

      const { username, email, password, display_name, captchaToken } = req.body || {};

            // --- VERIFY CAPTCHA ---
      const isHuman = await verifyTurnstile(captchaToken);
      if (!isHuman) {
        return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
      }

      if (!isValidUsername(username)) return res.status(400).json({ error: 'Username must be 3-20 characters, letters/numbers/underscores only' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
      if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      const existing = await client.execute({
        sql: 'SELECT id, username, email FROM users WHERE username = ? OR email = ?',
        args: [username, email],
      });
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.username.toLowerCase() === username.toLowerCase()) return res.status(409).json({ error: 'Username already taken' });
        return res.status(409).json({ error: 'Email already registered' });
      }

      const hash = await bcrypt.hash(password, 10);
      const finalDisplayName = (typeof display_name === 'string' && display_name.trim()) ? display_name.trim().slice(0, 40) : username;

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

      setSessionCookie(req, res, token, expiresAt);
      return res.status(200).json({
        user: { id: userId, username, display_name: finalDisplayName, is_admin: false, is_booster: false },
        token: token
      });
    }

    if (action === 'login' && req.method === 'POST') {
      if (await isIpBanned(client, ip)) return res.status(403).json({ error: 'Access denied' });
      const { username, password, captchaToken } = req.body || {};

            // --- VERIFY CAPTCHA ---
      const isHuman = await verifyTurnstile(captchaToken);
      if (!isHuman) {
        return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
      }

      if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

      // 1. Fetch the user from the database FIRST
      const result = await client.execute({
        sql: 'SELECT id, username, display_name, password_hash, is_admin, is_booster FROM users WHERE username = ? OR email = ?',
        args: [username, username],
      });

      if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });

      const user = result.rows[0];
      
      // 2. Verify the password
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

      // 4. Create the session and log them in
      await client.execute({ sql: 'UPDATE users SET ip = ? WHERE id = ?', args: [ip, user.id] });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = daysFromNow(SESSION_DAYS);
      
      await client.execute({
        sql: 'INSERT INTO sessions (token, user_id, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        args: [token, user.id, ip, now(), expiresAt],
      });

      setSessionCookie(req, res, token, expiresAt);
      return res.status(200).json({
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name || user.username,
          is_admin: user.is_admin == 1 || user.is_admin === true,
          is_booster: user.is_booster == 1 || user.is_booster === true,
        },
        token: token
      });
    }

    if (action === 'logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) {
        await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
      }
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    if (action === 'me' && req.method === 'GET') {
      const token = getSessionToken(req);
      if (!token) return res.status(200).json({ user: null });

      const result = await client.execute({
        sql: `SELECT u.id, u.username, u.display_name, u.is_admin, u.is_booster, s.expires_at
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
        user: {
          id: row.id,
          username: row.username,
          display_name: row.display_name || row.username,
          is_admin: row.is_admin == 1 || row.is_admin === true,
          is_booster: row.is_booster == 1 || row.is_booster === true,
        },
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

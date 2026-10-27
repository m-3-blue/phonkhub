import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function now() {
  return new Date().toISOString();
}

function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  if (typeof req.headers['x-real-ip'] === 'string') return req.headers['x-real-ip'];
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

async function isIpBanned(client, ip) {
  if (!ip || ip === 'unknown') return false;
  var result = await client.execute({ sql: 'SELECT 1 FROM banned_ips WHERE ip = ?', args: [ip] });
  return result.rows.length > 0;
}

// --- THE FIX: Check Authorization header first for Capacitor ---
function getSessionToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

async function getCurrentUser(client, req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await client.execute({
    sql: `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, username: result.rows[0].username };
}

export default async function handler(req, res) {
  // 1. STRICT CORS SETUP
  const ALLOWED_ORIGINS = [
    'https://o-phonkhub.vercel.app',
    'https://phonkhub.vercel.app',
    'https://localhost',
    'capacitor://localhost',
    'http://localhost:3000',
    'http://localhost:5173'
  ];

  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // Allow server-to-server or curl (no browser origin)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  // If origin is set but not in the list, we don't send CORS headers → browser blocks it
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = await getCurrentUser(client, req);
    if (!user) {
      return res.status(401).json({ error: 'Log in to vote' });
    }

    const { target_type, target_id, value } = req.body || {};
    const targetId = parseInt(target_id, 10);
    const val = parseInt(value, 10);

    if (target_type !== 'thread' && target_type !== 'reply') return res.status(400).json({ error: 'Invalid target_type' });
    if (!targetId) return res.status(400).json({ error: 'Missing target_id' });
    if (val !== 1 && val !== -1 && val !== 0) return res.status(400).json({ error: 'value must be 1, -1, or 0' });

    const table = target_type === 'thread' ? 'forum_threads' : 'forum_replies';
    const targetCheck = await client.execute({ sql: 'SELECT id FROM ' + table + ' WHERE id = ?', args: [targetId] });
    if (targetCheck.rows.length === 0) return res.status(404).json({ error: 'Target not found' });

    if (val === 0) {
      await client.execute({ sql: 'DELETE FROM forum_votes WHERE user_id = ? AND target_type = ? AND target_id = ?', args: [user.id, target_type, targetId] });
    } else {
      await client.execute({
        sql: `INSERT INTO forum_votes (user_id, target_type, target_id, value, ip, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, target_type, target_id)
              DO UPDATE SET value = excluded.value, ip = excluded.ip, created_at = excluded.created_at`,
        args: [user.id, target_type, targetId, val, ip, now()],
      });
    }

    const scoreResult = await client.execute({ sql: 'SELECT COALESCE(SUM(value), 0) AS score FROM forum_votes WHERE target_type = ? AND target_id = ?', args: [target_type, targetId] });
    const newScore = Number(scoreResult.rows[0].score) || 0;

    await client.execute({ sql: 'UPDATE ' + table + ' SET score = ? WHERE id = ?', args: [newScore, targetId] });

    const myVoteResult = await client.execute({ sql: 'SELECT value FROM forum_votes WHERE user_id = ? AND target_type = ? AND target_id = ?', args: [user.id, target_type, targetId] });
    const userVote = myVoteResult.rows.length > 0 ? Number(myVoteResult.rows[0].value) : 0;

    return res.status(200).json({ score: newScore, userVote: userVote });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';

const EMOJI_SET = {
  fire: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f525.png',
  skull: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f480.png',
  joy: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f602.png',
  sob: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f62d.png',
  heart: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2764.png',
  hundred: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4af.png',
  thumbsup: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44d.png',
  thumbsdown: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44e.png',
  thinking: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f914.png',
  eyes: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f440.png',
  clown: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f921.png',
  pray: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f64f.png',
};

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

async function getReactionsFor(client, targetType, targetIds, currentUserId) {
  if (targetIds.length === 0) return {};

  var placeholders = targetIds.map(function () { return '?'; }).join(',');
  var args = [targetType].concat(targetIds);

  var result = await client.execute({
    sql: `SELECT r.target_id, r.emoji, r.user_id, u.username
          FROM emoji_reactions r
          JOIN users u ON u.id = r.user_id
          WHERE r.target_type = ? AND r.target_id IN (` + placeholders + `)
          ORDER BY r.created_at ASC`,
    args: args,
  });

  var output = {};

  for (var i = 0; i < targetIds.length; i++) {
    output[targetIds[i]] = {};
  }

  for (var row of result.rows) {
    var tid = row.target_id;
    var emoji = row.emoji;

    if (!output[tid][emoji]) {
      output[tid][emoji] = { count: 0, users: [], userReacted: false };
    }
    output[tid][emoji].count++;
    output[tid][emoji].users.push(row.username);

    if (currentUserId && row.user_id === currentUserId) {
      output[tid][emoji].userReacted = true;
    }
  }

  return output;
}

export default async function handler(req, res) {
  // 1. DYNAMIC CORS SETUP
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const client = getClient();
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // -------- GET REACTIONS --------
    if (req.method === 'GET') {
      var targetType = req.query.target_type;
      var idsParam = req.query.ids;

      if (targetType !== 'thread' && targetType !== 'reply') return res.status(400).json({ error: 'Invalid target_type' });
      if (!idsParam) return res.status(400).json({ error: 'Missing ids' });

      var ids = idsParam.split(',').map(function (s) { return parseInt(s, 10); }).filter(function (n) { return !isNaN(n); });
      if (ids.length === 0) return res.status(400).json({ error: 'No valid ids' });

      var user = await getCurrentUser(client, req);
      var reactions = await getReactionsFor(client, targetType, ids, user ? user.id : null);

      return res.status(200).json({ reactions: reactions, emojis: EMOJI_SET });
    }

    // -------- TOGGLE REACTION --------
    if (req.method === 'POST') {
      var user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in to react' });

      var body = req.body || {};
      var pTargetType = body.target_type;
      var pTargetId = parseInt(body.target_id, 10);
      var pEmoji = body.emoji;

      if (pTargetType !== 'thread' && pTargetType !== 'reply') return res.status(400).json({ error: 'Invalid target_type' });
      if (!pTargetId) return res.status(400).json({ error: 'Missing target_id' });
      if (!pEmoji || !EMOJI_SET[pEmoji]) return res.status(400).json({ error: 'Invalid emoji' });

      var table = pTargetType === 'thread' ? 'forum_threads' : 'forum_replies';
      var targetCheck = await client.execute({ sql: 'SELECT id FROM ' + table + ' WHERE id = ?', args: [pTargetId] });
      if (targetCheck.rows.length === 0) return res.status(404).json({ error: 'Target not found' });

      var existing = await client.execute({
        sql: 'SELECT 1 FROM emoji_reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND emoji = ?',
        args: [user.id, pTargetType, pTargetId, pEmoji],
      });

      var nowReacted;
      if (existing.rows.length > 0) {
        await client.execute({
          sql: 'DELETE FROM emoji_reactions WHERE user_id = ? AND target_type = ? AND target_id = ? AND emoji = ?',
          args: [user.id, pTargetType, pTargetId, pEmoji],
        });
        nowReacted = false;
      } else {
        await client.execute({
          sql: 'INSERT OR IGNORE INTO emoji_reactions (user_id, target_type, target_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [user.id, pTargetType, pTargetId, pEmoji, now()],
        });
        nowReacted = true;
      }

      var updated = await getReactionsFor(client, pTargetType, [pTargetId], user.id);

      return res.status(200).json({ ok: true, userReacted: nowReacted, reactions: updated[pTargetId] || {} });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

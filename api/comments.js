import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';
const MAX_BODY = 100;

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

function containsUrl(text) {
  var pattern = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|net|org|io|gg|co|us|uk|xyz|online|site|dev|app|tv|me|info|biz)\b/i;
  return pattern.test(text);
}

async function getCurrentUser(client, req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await client.execute({
    sql: `SELECT u.id, u.username, u.display_name, u.is_booster FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    display_name: result.rows[0].display_name || result.rows[0].username,
    is_booster: result.rows[0].is_booster, // ADD THIS LINE
  };
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

  const client = getClient();
  const action = req.query.action;
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // -------- LIST COMMENTS --------
    if (action === 'list' && req.method === 'GET') {
      const trackId = parseInt(req.query.track_id, 10);
      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });

      const result = await client.execute({
        sql: `SELECT c.id, c.track_id, c.parent_id, c.body, c.created_at, c.edited_at,
                     u.id AS user_id, u.username, u.display_name, u.is_booster
              FROM comments c JOIN users u ON u.id = c.user_id
              WHERE c.track_id = ? ORDER BY c.created_at ASC`,
        args: [trackId],
      });

      const likesResult = await client.execute({
        sql: `SELECT cl.comment_id, COUNT(*) AS like_count FROM comment_likes cl
              JOIN comments c ON c.id = cl.comment_id WHERE c.track_id = ? GROUP BY cl.comment_id`,
        args: [trackId],
      });

      const likeCounts = {};
      for (const row of likesResult.rows) likeCounts[row.comment_id] = Number(row.like_count);

      const user = await getCurrentUser(client, req);
      let userLikes = {};
      if (user) {
        const myLikes = await client.execute({
          sql: `SELECT cl.comment_id FROM comment_likes cl
                JOIN comments c ON c.id = cl.comment_id WHERE c.track_id = ? AND cl.user_id = ?`,
          args: [trackId, user.id],
        });
        for (const row of myLikes.rows) userLikes[row.comment_id] = true;
      }

      const byId = {};
      const topLevel = [];

      for (const row of result.rows) {
        byId[row.id] = {
          id: row.id, track_id: row.track_id, parent_id: row.parent_id,
          body: row.body, created_at: row.created_at, edited_at: row.edited_at || null,
          user: { id: row.user_id, username: row.username, display_name: row.display_name || row.username, is_booster: row.is_booster },
          like_count: likeCounts[row.id] || 0, user_liked: !!userLikes[row.id], replies: [],
        };
      }

      for (const row of result.rows) {
        const node = byId[row.id];
        if (row.parent_id && byId[row.parent_id]) byId[row.parent_id].replies.push(node);
        else topLevel.push(node);
      }

      return res.status(200).json({ comments: topLevel, user });
    }

    // -------- POST A COMMENT --------
    if (action === 'post' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in to comment' });

      const { track_id, parent_id, body } = req.body || {};
      const trackId = parseInt(track_id, 10);

      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });
      if (typeof body !== 'string' || body.trim().length === 0) return res.status(400).json({ error: 'Comment cannot be empty' });
      if (body.trim().length > MAX_BODY) return res.status(400).json({ error: 'Max ' + MAX_BODY + ' characters' });
      if (containsUrl(body)) return res.status(400).json({ error: 'Links are not allowed in comments' });

      const trackExists = await client.execute({ sql: 'SELECT id FROM tracks WHERE id = ?', args: [trackId] });
      if (trackExists.rows.length === 0) return res.status(404).json({ error: 'Track not found' });

      let parentId = null;
      if (parent_id) {
        const parsedParent = parseInt(parent_id, 10);
        const parentExists = await client.execute({
          sql: 'SELECT id, user_id FROM comments WHERE id = ? AND track_id = ?',
          args: [parsedParent, trackId],
        });
        if (parentExists.rows.length === 0) return res.status(404).json({ error: 'Parent comment not found' });
        parentId = parsedParent;

        // 1. NOTIFY REPLY OWNER
        const parentUserId = parentExists.rows[0].user_id;
        if (parentUserId !== user.id) {
          await client.execute({
            sql: 'INSERT INTO notifications (user_id, actor_id, type, link, created_at) VALUES (?, ?, ?, ?, ?)',
            args: [parentUserId, user.id, 'reply', '/track-' + trackId, now()],
          });
        }
      }

      const result = await client.execute({
        sql: 'INSERT INTO comments (track_id, user_id, parent_id, body, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [trackId, user.id, parentId, body.trim(), ip, now()],
      });

      // 2. NOTIFY @MENTIONS
      const mentionRegex = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{3,20})\b/g;
      let match;
      const mentions = new Set();
      while ((match = mentionRegex.exec(body)) !== null) mentions.add(match[2]);
      
      mentions.delete(user.username); // Don't notify yourself

      for (const mentionUsername of mentions) {
        const mentionRes = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [mentionUsername] });
        if (mentionRes.rows.length > 0) {
          const mentionedUserId = mentionRes.rows[0].id;
          await client.execute({
            sql: 'INSERT INTO notifications (user_id, actor_id, type, link, created_at) VALUES (?, ?, ?, ?, ?)',
            args: [mentionedUserId, user.id, 'mention', '/track-' + trackId, now()],
          });
        }
      }

      return res.status(200).json({
        comment: {
          id: Number(result.lastInsertRowid), track_id: trackId, parent_id: parentId,
          body: body.trim(), created_at: now(), edited_at: null,
          user: { id: user.id, username: user.username, display_name: user.display_name, is_booster: user.is_booster },
          like_count: 0, user_liked: false, replies: [],
        },
      });
    }

    // -------- EDIT OWN COMMENT --------
    if (action === 'edit' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in first' });

      const { id, body } = req.body || {};
      const commentId = parseInt(id, 10);

      if (!commentId) return res.status(400).json({ error: 'Missing id' });
      if (typeof body !== 'string' || body.trim().length === 0) return res.status(400).json({ error: 'Comment cannot be empty' });
      if (body.trim().length > MAX_BODY) return res.status(400).json({ error: 'Max ' + MAX_BODY + ' characters' });
      if (containsUrl(body)) return res.status(400).json({ error: 'Links are not allowed in comments' });

      const check = await client.execute({ sql: 'SELECT user_id FROM comments WHERE id = ?', args: [commentId] });
      if (check.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
      if (Number(check.rows[0].user_id) !== user.id) return res.status(403).json({ error: 'You can only edit your own comments' });

      await client.execute({ sql: 'UPDATE comments SET body = ?, edited_at = ? WHERE id = ?', args: [body.trim(), now(), commentId] });
      return res.status(200).json({ ok: true });
    }

    // -------- DELETE OWN COMMENT --------
    if (action === 'delete' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in first' });

      const { id } = req.body || {};
      const commentId = parseInt(id, 10);
      if (!commentId) return res.status(400).json({ error: 'Missing id' });

      const check = await client.execute({ sql: 'SELECT user_id FROM comments WHERE id = ?', args: [commentId] });
      if (check.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
      if (Number(check.rows[0].user_id) !== user.id) return res.status(403).json({ error: 'You can only delete your own comments' });

      await client.execute({ sql: 'DELETE FROM comments WHERE id = ?', args: [commentId] });
      return res.status(200).json({ ok: true });
    }

    // -------- LIKE / UNLIKE --------
    if (action === 'like' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in to like' });

      const { id } = req.body || {};
      const commentId = parseInt(id, 10);
      if (!commentId) return res.status(400).json({ error: 'Missing id' });

      const check = await client.execute({ sql: 'SELECT id FROM comments WHERE id = ?', args: [commentId] });
      if (check.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });

      const existing = await client.execute({ sql: 'SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?', args: [user.id, commentId] });

      let liked;
      if (existing.rows.length > 0) {
        await client.execute({ sql: 'DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?', args: [user.id, commentId] });
        liked = false;
      } else {
        await client.execute({ sql: 'INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)', args: [user.id, commentId, now()] });
        liked = true;
      }

      const countResult = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?', args: [commentId] });
      return res.status(200).json({ liked, like_count: Number(countResult.rows[0].c) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const trackId = parseInt(req.query.id, 10);
    if (!trackId) {
      return res.status(400).json({ error: 'Missing id' });
    }

    const trackResult = await client.execute({
      sql: 'SELECT * FROM tracks WHERE id = ?',
      args: [trackId],
    });

    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const track = trackResult.rows[0];
    const token = getSessionToken(req);

    const [recommendedResult, scoreResult, userResult] = await Promise.all([
      client.execute({
        sql: 'SELECT * FROM tracks WHERE id != ? ORDER BY RANDOM() LIMIT 3',
        args: [trackId],
      }),
      client.execute({
        sql: 'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE track_id = ?',
        args: [trackId],
      }),
      token
        ? client.execute({
            sql: `SELECT u.id, u.username, u.display_name
                  FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE s.token = ? AND s.expires_at > ?`,
            args: [token, new Date().toISOString()],
          })
        : Promise.resolve({ rows: [] }),
    ]);

    const user = userResult.rows.length > 0
      ? {
          id: userResult.rows[0].id,
          username: userResult.rows[0].username,
          display_name: userResult.rows[0].display_name || userResult.rows[0].username,
        }
      : null;

    let userVote = 0;
    if (user) {
      const voteResult = await client.execute({
        sql: 'SELECT value FROM votes WHERE user_id = ? AND track_id = ?',
        args: [user.id, trackId],
      });
      if (voteResult.rows.length > 0) {
        userVote = Number(voteResult.rows[0].value);
      }
    }

    return res.status(200).json({
      track,
      recommended: recommendedResult.rows,
      score: Number(scoreResult.rows[0].score) || 0,
      userVote,
      user,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
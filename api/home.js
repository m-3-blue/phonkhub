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
  const token = getSessionToken(req);
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const [tracksResult, scoresResult, userResult] = await Promise.all([
      client.execute('SELECT * FROM tracks ORDER BY id ASC'),
      client.execute('SELECT track_id, COALESCE(SUM(value), 0) AS score FROM votes GROUP BY track_id'),
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

    const scores = {};
    for (const row of scoresResult.rows) {
      scores[row.track_id] = Number(row.score);
    }

    let userVotes = {};
    if (user) {
      const myVotes = await client.execute({
        sql: 'SELECT track_id, value FROM votes WHERE user_id = ?',
        args: [user.id],
      });
      for (const row of myVotes.rows) {
        userVotes[row.track_id] = Number(row.value);
      }
    }

    return res.status(200).json({
      tracks: tracksResult.rows,
      scores,
      userVotes,
      user,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
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

  try {
    const [tracksResult, scoresResult, userResult] = await Promise.all([
      client.execute('SELECT * FROM tracks ORDER BY id ASC'),
      client.execute('SELECT track_id, COALESCE(SUM(value), 0) AS score FROM votes GROUP BY track_id'),
      token
        ? client.execute({
            sql: `SELECT u.id, u.username
                  FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE s.token = ? AND s.expires_at > ?`,
            args: [token, new Date().toISOString()],
          })
        : Promise.resolve({ rows: [] }),
    ]);

    const user = userResult.rows.length > 0
      ? { id: userResult.rows[0].id, username: userResult.rows[0].username }
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
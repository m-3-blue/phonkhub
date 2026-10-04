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

async function getCurrentUser(client, req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await client.execute({
    sql: `SELECT u.id, u.username, s.expires_at
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`,
    args: [token],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  if (new Date(row.expires_at) < new Date()) {
    await client.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
    return null;
  }

  return { id: row.id, username: row.username };
}

export default async function handler(req, res) {
  const client = getClient();
  const action = req.query.action;

  try {
    // -------- GET VOTES FOR A TRACK (public) --------
    if (action === 'for-track' && req.method === 'GET') {
      const trackId = parseInt(req.query.track_id, 10);
      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });

      const scoreResult = await client.execute({
        sql: 'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE track_id = ?',
        args: [trackId],
      });

      const score = Number(scoreResult.rows[0].score) || 0;

      // Also return the current user's vote on this track (if logged in)
      const user = await getCurrentUser(client, req);
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

      return res.status(200).json({ score, userVote });
    }

    // -------- GET SCORES FOR MANY TRACKS (public, for homepage) --------
    if (action === 'all' && req.method === 'GET') {
      const scores = await client.execute(
        'SELECT track_id, COALESCE(SUM(value), 0) AS score FROM votes GROUP BY track_id'
      );

      const user = await getCurrentUser(client, req);
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

      const result = {};
      for (const row of scores.rows) {
        result[row.track_id] = Number(row.score);
      }

      return res.status(200).json({ scores: result, userVotes });
    }

    // -------- CAST / CHANGE / REMOVE VOTE --------
    if (action === 'cast' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in to vote' });

      const { track_id, value } = req.body || {};
      const trackId = parseInt(track_id, 10);
      const val = parseInt(value, 10);

      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });
      if (val !== 1 && val !== -1 && val !== 0) {
        return res.status(400).json({ error: 'value must be 1, -1, or 0' });
      }

      // Make sure track exists
      const trackExists = await client.execute({
        sql: 'SELECT id FROM tracks WHERE id = ?',
        args: [trackId],
      });
      if (trackExists.rows.length === 0) {
        return res.status(404).json({ error: 'Track not found' });
      }

      // value === 0 means "remove my vote"
      if (val === 0) {
        await client.execute({
          sql: 'DELETE FROM votes WHERE user_id = ? AND track_id = ?',
          args: [user.id, trackId],
        });
      } else {
        await client.execute({
          sql: `INSERT INTO votes (user_id, track_id, value, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, track_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
          args: [user.id, trackId, val, now()],
        });
      }

      // Return new score + this user's vote
      const newScore = await client.execute({
        sql: 'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE track_id = ?',
        args: [trackId],
      });

      const myVote = await client.execute({
        sql: 'SELECT value FROM votes WHERE user_id = ? AND track_id = ?',
        args: [user.id, trackId],
      });

      return res.status(200).json({
        score: Number(newScore.rows[0].score) || 0,
        userVote: myVote.rows.length > 0 ? Number(myVote.rows[0].value) : 0,
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
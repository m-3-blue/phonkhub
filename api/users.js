import { createClient } from '@libsql/client';

const DEFAULT_ACCENT = '#ff9900';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: 'Missing username' });
  }

  const client = getClient();

  try {
    const userResult = await client.execute({
      sql: 'SELECT id, username, display_name, bio, socials, accent_color, created_at FROM users WHERE username = ?',
      args: [username],
    });

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    let socials = {};
    if (user.socials) {
      try { socials = JSON.parse(user.socials); } catch (e) { socials = {}; }
    }

    const [votesResult, commentsResult, countsResult] = await Promise.all([
      client.execute({
        sql: `SELECT v.value, v.created_at AS voted_at,
                     t.id, t.youtube_id, t.title, t.artist
              FROM votes v
              JOIN tracks t ON t.id = v.track_id
              WHERE v.user_id = ?
              ORDER BY v.created_at DESC`,
        args: [user.id],
      }),

      client.execute({
        sql: `SELECT c.id, c.body, c.created_at, c.parent_id,
                     t.id AS track_id, t.title AS track_title, t.youtube_id
              FROM comments c
              JOIN tracks t ON t.id = c.track_id
              WHERE c.user_id = ?
              ORDER BY c.created_at DESC
              LIMIT 100`,
        args: [user.id],
      }),

      client.execute({
        sql: `SELECT
                (SELECT COUNT(*) FROM comments WHERE user_id = ?) AS comment_count,
                (SELECT COUNT(*) FROM votes WHERE user_id = ?) AS vote_count`,
        args: [user.id, user.id],
      }),
    ]);

    const counts = countsResult.rows[0] || { comment_count: 0, vote_count: 0 };

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
        bio: user.bio || '',
        socials: socials,
        accent_color: user.accent_color || DEFAULT_ACCENT,
        created_at: user.created_at,
      },
      votes: votesResult.rows,
      comments: commentsResult.rows,
      counts: {
        comments: Number(counts.comment_count) || 0,
        votes: Number(counts.vote_count) || 0,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
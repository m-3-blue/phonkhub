import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';
const DEFAULT_ACCENT = '#ff9900';

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
    sql: `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, username: result.rows[0].username };
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
      sql: `SELECT id, username, display_name, bio, socials, accent_color, created_at, is_admin, is_booster, avatar_url, banner_url,
              (SELECT COUNT(*) FROM follows WHERE following_id = users.id) AS follower_count,
              (SELECT COUNT(*) FROM follows WHERE follower_id = users.id) AS following_count
            FROM users WHERE username = ?`,
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

    const [votesResult, commentsResult, countsResult, threadsResult, repliesResult] = await Promise.all([
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

      client.execute({
        sql: `SELECT t.id, t.title, t.created_at, c.name AS category_name 
              FROM forum_threads t 
              JOIN forum_categories c ON c.id = t.category_id 
              WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 10`,
        args: [user.id],
      }),

      client.execute({
        sql: `SELECT r.id, r.body, r.created_at, t.id AS thread_id, t.title AS thread_title 
              FROM forum_replies r 
              JOIN forum_threads t ON t.id = r.thread_id 
              WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 10`,
        args: [user.id],
      }),
    ]);

    const counts = countsResult.rows[0] || { comment_count: 0, vote_count: 0 };

      // Check if requester follows this user
    const requester = await getCurrentUser(client, req);
    let isFollowing = false;
    if (requester && requester.id !== user.id) {
      const followCheck = await client.execute({
        sql: 'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?',
        args: [requester.id, user.id],
      });
      isFollowing = followCheck.rows.length > 0;
    }

    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name || user.username,
        bio: user.bio || '',
        socials: socials,
        accent_color: user.accent_color || DEFAULT_ACCENT,
        created_at: user.created_at,
        is_admin: user.is_admin || 0,
        is_booster: user.is_booster || 0,
        avatar_url: user.avatar_url || null,
        banner_url: user.banner_url || null,
        follower_count: Number(user.follower_count) || 0,
        following_count: Number(user.following_count) || 0,
        is_following: isFollowing,
      },
      votes: votesResult.rows,
      comments: commentsResult.rows,
      counts: {
        comments: Number(counts.comment_count) || 0,
        votes: Number(counts.vote_count) || 0,
      },
      threads: threadsResult.rows,
      forumReplies: repliesResult.rows
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

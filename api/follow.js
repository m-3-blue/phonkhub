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
    sql: `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, username: result.rows[0].username };
}

export default async function handler(req, res) {
  const client = getClient();
  const action = req.query.action;

  try {
    // GET FOLLOWERS / FOLLOWING LISTS
    if (req.method === 'GET' && (action === 'followers' || action === 'following')) {
      const username = req.query.username;
      if (!username) return res.status(400).json({ error: 'Missing username' });

      const userRes = await client.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const userId = userRes.rows[0].id;

      let sql;
      if (action === 'followers') {
        sql = `SELECT u.username, u.display_name FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.following_id = ? ORDER BY f.created_at DESC`;
      } else {
        sql = `SELECT u.username, u.display_name FROM follows f JOIN users u ON u.id = f.following_id WHERE f.follower_id = ? ORDER BY f.created_at DESC`;
      }

      const result = await client.execute({ sql, args: [userId] });
      return res.status(200).json({ users: result.rows });
    }

    // TOGGLE FOLLOW
    if (req.method === 'POST' && action === 'toggle') {
      const me = await getCurrentUser(client, req);
      if (!me) return res.status(401).json({ error: 'Log in to follow' });

      const { target_id } = req.body || {};
      const targetId = parseInt(target_id, 10);
      if (!targetId) return res.status(400).json({ error: 'Missing target_id' });
      if (targetId === me.id) return res.status(400).json({ error: "You can't follow yourself" });

      const existing = await client.execute({
        sql: 'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?',
        args: [me.id, targetId],
      });

      let following;
      if (existing.rows.length > 0) {
        await client.execute({
          sql: 'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
          args: [me.id, targetId],
        });
        following = false;
      } else {
        await client.execute({
          sql: 'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)',
          args: [me.id, targetId, now()],
        });
        following = true;

        // Notification Trigger
        await client.execute({
          sql: 'INSERT INTO notifications (user_id, actor_id, type, link, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [targetId, me.id, 'follow', '/@' + me.username, now()],
        });
      }

      const countRes = await client.execute({
        sql: 'SELECT COUNT(*) AS c FROM follows WHERE following_id = ?',
        args: [targetId],
      });

      return res.status(200).json({ following, followerCount: Number(countRes.rows[0].c) });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
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
    const user = await getCurrentUser(client, req);
    if (!user) return res.status(401).json({ error: 'Log in first' });

    // -------- GET NOTIFICATIONS --------
    if (req.method === 'GET') {
      const result = await client.execute({
        sql: `SELECT 
                n.id, n.type, n.link, n.is_read, n.created_at,
                u.username AS actor_username, u.display_name AS actor_display_name
              FROM notifications n
              JOIN users u ON u.id = n.actor_id
              WHERE n.user_id = ?
              ORDER BY n.created_at DESC
              LIMIT 20`,
        args: [user.id],
      });

      const unreadCountResult = await client.execute({
        sql: 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
        args: [user.id],
      });

      return res.status(200).json({
        notifications: result.rows,
        unreadCount: Number(unreadCountResult.rows[0].c),
      });
    }

    // -------- MARK ALL AS READ --------
    if (req.method === 'POST' && action === 'read-all') {
      await client.execute({
        sql: 'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
        args: [user.id],
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
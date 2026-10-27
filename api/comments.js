import { createClient } from '@libsql/client';
import cookie from 'cookie';

const SESSION_COOKIE = 'ph_session';
const MAX_COMMENT_LENGTH = 100;

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
    sql: `SELECT u.id, u.username, u.display_name, u.is_admin 
          FROM sessions s JOIN users u ON u.id = s.user_id 
          WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    display_name: result.rows[0].display_name || result.rows[0].username,
    is_admin: !!result.rows[0].is_admin,
  };
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
  const action = req.query.action || 'list';

  try {
    if (req.method === 'GET' && action === 'list') {
      const trackId = req.query.track_id;
      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });

      const user = await getCurrentUser(client, req);

      const result = await client.execute({
        sql: `
          SELECT c.id, c.body, c.parent_id, c.created_at, c.edited_at, c.user_id,
                 u.username, u.display_name,
                 (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) as like_count,
                 ${user ? '(SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id AND cl.user_id = ?) as user_liked' : '0 as user_liked'}
          FROM comments c
          JOIN users u ON u.id = c.user_id
          WHERE c.track_id = ?
          ORDER BY c.created_at ASC
        `,
        args: user ? [user.id, trackId] : [trackId],
      });

      const allComments = result.rows;
      const commentMap = {};
      const topLevel = [];

      allComments.forEach(c => {
        c.replies = [];
        commentMap[c.id] = c;
      });

      allComments.forEach(c => {
        if (c.parent_id) {
          if (commentMap[c.parent_id]) {
            commentMap[c.parent_id].replies.push(c);
          }
        } else {
          topLevel.push(c);
        }
      });

      return res.status(200).json({ comments: topLevel });

    } else if (req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Not logged in' });

      if (action === 'post') {
        const { track_id, parent_id, body } = req.body;
        if (!track_id || !body || body.length > MAX_COMMENT_LENGTH) {
          return res.status(400).json({ error: 'Invalid comment' });
        }
        
        const result = await client.execute({
          sql: 'INSERT INTO comments (track_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
          args: [track_id, user.id, parent_id || null, body, now()],
        });
        
        // Handle mention notifications here if you have them...
        
        return res.status(200).json({ success: true, id: result.rows[0].id });

      } else if (action === 'edit') {
        const { id, body } = req.body;
        if (!id || !body || body.length > MAX_COMMENT_LENGTH) {
          return res.status(400).json({ error: 'Invalid edit' });
        }

        const check = await client.execute({
          sql: 'SELECT user_id FROM comments WHERE id = ?',
          args: [id]
        });
        if (check.rows.length === 0 || (check.rows[0].user_id !== user.id && !user.is_admin)) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        await client.execute({
          sql: 'UPDATE comments SET body = ?, edited_at = ? WHERE id = ?',
          args: [body, now(), id]
        });
        return res.status(200).json({ success: true });

      } else if (action === 'delete') {
        const { id } = req.body;
        const check = await client.execute({
          sql: 'SELECT user_id FROM comments WHERE id = ?',
          args: [id]
        });
        if (check.rows.length === 0 || (check.rows[0].user_id !== user.id && !user.is_admin)) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        await client.execute({
          sql: 'DELETE FROM comments WHERE id = ? OR parent_id = ?',
          args: [id, id]
        });
        return res.status(200).json({ success: true });

      } else if (action === 'like') {
        const { id } = req.body;
        const existing = await client.execute({
          sql: 'SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?',
          args: [id, user.id]
        });

        let liked = false;
        if (existing.rows.length > 0) {
          await client.execute({
            sql: 'DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?',
            args: [id, user.id]
          });
        } else {
          await client.execute({
            sql: 'INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)',
            args: [id, user.id]
          });
          liked = true;
        }

        const countRes = await client.execute({
          sql: 'SELECT COUNT(*) as count FROM comment_likes WHERE comment_id = ?',
          args: [id]
        });

        return res.status(200).json({ liked, like_count: countRes.rows[0].count });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

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

function containsUrl(text) {
  var pattern = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|net|org|io|gg|co|us|uk|xyz|online|site|dev|app|tv|me|info|biz)\b/i;
  return pattern.test(text);
}

async function getCurrentUser(client, req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await client.execute({
    sql: `SELECT u.id, u.username, u.display_name
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    display_name: result.rows[0].display_name || result.rows[0].username,
  };
}

export default async function handler(req, res) {
  const client = getClient();
  const action = req.query.action;

  try {
    // -------- LIST COMMENTS FOR A TRACK --------
    if (action === 'list' && req.method === 'GET') {
      const trackId = parseInt(req.query.track_id, 10);
      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });

      const result = await client.execute({
        sql: `SELECT c.id, c.track_id, c.parent_id, c.body, c.created_at, c.edited_at,
                     u.id AS user_id, u.username, u.display_name
              FROM comments c
              JOIN users u ON u.id = c.user_id
              WHERE c.track_id = ?
              ORDER BY c.created_at ASC`,
        args: [trackId],
      });

      // Get all like counts for this track's comments
      const likesResult = await client.execute({
        sql: `SELECT cl.comment_id, COUNT(*) AS like_count
              FROM comment_likes cl
              JOIN comments c ON c.id = cl.comment_id
              WHERE c.track_id = ?
              GROUP BY cl.comment_id`,
        args: [trackId],
      });

      const likeCounts = {};
      for (const row of likesResult.rows) {
        likeCounts[row.comment_id] = Number(row.like_count);
      }

      // Who's logged in? (needed to know which comments they've liked)
      const user = await getCurrentUser(client, req);

      let userLikes = {};
      if (user) {
        const myLikes = await client.execute({
          sql: `SELECT cl.comment_id
                FROM comment_likes cl
                JOIN comments c ON c.id = cl.comment_id
                WHERE c.track_id = ? AND cl.user_id = ?`,
          args: [trackId, user.id],
        });
        for (const row of myLikes.rows) {
          userLikes[row.comment_id] = true;
        }
      }

      const byId = {};
      const topLevel = [];

      for (const row of result.rows) {
        byId[row.id] = {
          id: row.id,
          track_id: row.track_id,
          parent_id: row.parent_id,
          body: row.body,
          created_at: row.created_at,
          edited_at: row.edited_at || null,
          user: {
            id: row.user_id,
            username: row.username,
            display_name: row.display_name || row.username,
          },
          like_count: likeCounts[row.id] || 0,
          user_liked: !!userLikes[row.id],
          replies: [],
        };
      }

      for (const row of result.rows) {
        const node = byId[row.id];
        if (row.parent_id && byId[row.parent_id]) {
          byId[row.parent_id].replies.push(node);
        } else {
          topLevel.push(node);
        }
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

      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Comment cannot be empty' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Max ' + MAX_BODY + ' characters' });
      }
      if (containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed in comments' });
      }

      const trackExists = await client.execute({
        sql: 'SELECT id FROM tracks WHERE id = ?',
        args: [trackId],
      });
      if (trackExists.rows.length === 0) {
        return res.status(404).json({ error: 'Track not found' });
      }

      let parentId = null;
      if (parent_id) {
        const parsedParent = parseInt(parent_id, 10);
        const parentExists = await client.execute({
          sql: 'SELECT id FROM comments WHERE id = ? AND track_id = ?',
          args: [parsedParent, trackId],
        });
        if (parentExists.rows.length === 0) {
          return res.status(404).json({ error: 'Parent comment not found' });
        }
        parentId = parsedParent;
      }

      const result = await client.execute({
        sql: 'INSERT INTO comments (track_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [trackId, user.id, parentId, body.trim(), now()],
      });

      return res.status(200).json({
        comment: {
          id: Number(result.lastInsertRowid),
          track_id: trackId,
          parent_id: parentId,
          body: body.trim(),
          created_at: now(),
          edited_at: null,
          user: { id: user.id, username: user.username, display_name: user.display_name },
          like_count: 0,
          user_liked: false,
          replies: [],
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

      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Comment cannot be empty' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Max ' + MAX_BODY + ' characters' });
      }
      if (containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed in comments' });
      }

      const check = await client.execute({
        sql: 'SELECT user_id FROM comments WHERE id = ?',
        args: [commentId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Comment not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id) {
        return res.status(403).json({ error: 'You can only edit your own comments' });
      }

      await client.execute({
        sql: 'UPDATE comments SET body = ?, edited_at = ? WHERE id = ?',
        args: [body.trim(), now(), commentId],
      });

      return res.status(200).json({ ok: true });
    }

    // -------- DELETE OWN COMMENT --------
    if (action === 'delete' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in first' });

      const { id } = req.body || {};
      const commentId = parseInt(id, 10);
      if (!commentId) return res.status(400).json({ error: 'Missing id' });

      const check = await client.execute({
        sql: 'SELECT user_id FROM comments WHERE id = ?',
        args: [commentId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Comment not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id) {
        return res.status(403).json({ error: 'You can only delete your own comments' });
      }

      await client.execute({
        sql: 'DELETE FROM comments WHERE id = ?',
        args: [commentId],
      });

      return res.status(200).json({ ok: true });
    }

    // -------- LIKE / UNLIKE A COMMENT --------
    if (action === 'like' && req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in to like' });

      const { id } = req.body || {};
      const commentId = parseInt(id, 10);
      if (!commentId) return res.status(400).json({ error: 'Missing id' });

      // Check the comment exists
      const check = await client.execute({
        sql: 'SELECT id FROM comments WHERE id = ?',
        args: [commentId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      // Toggle
      const existing = await client.execute({
        sql: 'SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?',
        args: [user.id, commentId],
      });

      let liked;
      if (existing.rows.length > 0) {
        await client.execute({
          sql: 'DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?',
          args: [user.id, commentId],
        });
        liked = false;
      } else {
        await client.execute({
          sql: 'INSERT INTO comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)',
          args: [user.id, commentId, now()],
        });
        liked = true;
      }

      const countResult = await client.execute({
        sql: 'SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?',
        args: [commentId],
      });

      return res.status(200).json({
        liked: liked,
        like_count: Number(countResult.rows[0].c),
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
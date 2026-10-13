import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';
const MAX_TITLE = 200;
const MAX_BODY = 200;

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

function now() {
  return new Date().toISOString();
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

function containsUrl(text) {
  var pattern = /(https?:\/\/|www\.)\S+|\b[\w-]+\.(com|net|org|io|gg|co|us|uk|xyz|online|site|dev|app|tv|me|info|biz)\b/i;
  return pattern.test(text);
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();
  const ip = getClientIp(req);
  const action = req.query.action;

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = await getCurrentUser(client, req);
    if (!user) {
      return res.status(401).json({ error: 'Log in first' });
    }

    // -------- CREATE THREAD --------
    if (action === 'create-thread') {
      const { category_slug, title, body } = req.body || {};

      if (!category_slug) return res.status(400).json({ error: 'Missing category' });
      if (typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title required' });
      }
      if (title.trim().length > MAX_TITLE) {
        return res.status(400).json({ error: 'Title too long (max ' + MAX_TITLE + ' chars)' });
      }
      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Body required' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Body too long (max ' + MAX_BODY + ' chars)' });
      }
      if (containsUrl(title) || containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed' });
      }

      const catResult = await client.execute({
        sql: 'SELECT id, admin_only FROM forum_categories WHERE slug = ?',
        args: [category_slug],
      });
      if (catResult.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }
      const category = catResult.rows[0];

      if (category.admin_only && !user.is_admin) {
        return res.status(403).json({ error: 'Only admins can post here' });
      }

      const result = await client.execute({
        sql: `INSERT INTO forum_threads (category_id, user_id, title, body, ip, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [category.id, user.id, title.trim(), body.trim(), ip, now()],
      });

      return res.status(200).json({
        ok: true,
        thread_id: Number(result.lastInsertRowid),
      });
    }

    // -------- CREATE REPLY --------
    if (action === 'create-reply') {
      const { thread_id, parent_id, body } = req.body || {};
      const threadId = parseInt(thread_id, 10);

      if (!threadId) return res.status(400).json({ error: 'Missing thread_id' });
      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Body required' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Body too long (max ' + MAX_BODY + ' chars)' });
      }
      if (containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed' });
      }

      const threadResult = await client.execute({
        sql: `SELECT t.id, c.admin_only
              FROM forum_threads t
              JOIN forum_categories c ON c.id = t.category_id
              WHERE t.id = ?`,
        args: [threadId],
      });
      if (threadResult.rows.length === 0) {
        return res.status(404).json({ error: 'Thread not found' });
      }
      if (threadResult.rows[0].admin_only && !user.is_admin) {
        return res.status(403).json({ error: 'Only admins can reply here' });
      }

      let parentId = null;
      if (parent_id) {
        const parsedParent = parseInt(parent_id, 10);
        const parentExists = await client.execute({
          sql: 'SELECT id FROM forum_replies WHERE id = ? AND thread_id = ?',
          args: [parsedParent, threadId],
        });
        if (parentExists.rows.length === 0) {
          return res.status(404).json({ error: 'Parent reply not found' });
        }
        parentId = parsedParent;
      }

      const result = await client.execute({
        sql: `INSERT INTO forum_replies (thread_id, user_id, parent_id, body, ip, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [threadId, user.id, parentId, body.trim(), ip, now()],
      });

      return res.status(200).json({
        ok: true,
        reply_id: Number(result.lastInsertRowid),
      });
    }

    // -------- EDIT THREAD --------
    if (action === 'edit-thread') {
      const { id, title, body } = req.body || {};
      const threadId = parseInt(id, 10);

      if (!threadId) return res.status(400).json({ error: 'Missing id' });
      if (typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title required' });
      }
      if (title.trim().length > MAX_TITLE) {
        return res.status(400).json({ error: 'Title too long' });
      }
      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Body required' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Body too long' });
      }
      if (containsUrl(title) || containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed' });
      }

      const check = await client.execute({
        sql: 'SELECT user_id FROM forum_threads WHERE id = ?',
        args: [threadId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Thread not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id && !user.is_admin) {
        return res.status(403).json({ error: 'Not your thread' });
      }

      await client.execute({
        sql: 'UPDATE forum_threads SET title = ?, body = ?, edited_at = ? WHERE id = ?',
        args: [title.trim(), body.trim(), now(), threadId],
      });

      return res.status(200).json({ ok: true });
    }

    // -------- EDIT REPLY --------
    if (action === 'edit-reply') {
      const { id, body } = req.body || {};
      const replyId = parseInt(id, 10);

      if (!replyId) return res.status(400).json({ error: 'Missing id' });
      if (typeof body !== 'string' || body.trim().length === 0) {
        return res.status(400).json({ error: 'Body required' });
      }
      if (body.trim().length > MAX_BODY) {
        return res.status(400).json({ error: 'Body too long' });
      }
      if (containsUrl(body)) {
        return res.status(400).json({ error: 'Links are not allowed' });
      }

      const check = await client.execute({
        sql: 'SELECT user_id FROM forum_replies WHERE id = ?',
        args: [replyId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id && !user.is_admin) {
        return res.status(403).json({ error: 'Not your reply' });
      }

      await client.execute({
        sql: 'UPDATE forum_replies SET body = ?, edited_at = ? WHERE id = ?',
        args: [body.trim(), now(), replyId],
      });

      return res.status(200).json({ ok: true });
    }

    // -------- DELETE THREAD --------
    if (action === 'delete-thread') {
      const { id } = req.body || {};
      const threadId = parseInt(id, 10);
      if (!threadId) return res.status(400).json({ error: 'Missing id' });

      const check = await client.execute({
        sql: 'SELECT user_id FROM forum_threads WHERE id = ?',
        args: [threadId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Thread not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id && !user.is_admin) {
        return res.status(403).json({ error: 'Not your thread' });
      }

      await client.execute({
        sql: `DELETE FROM forum_votes
              WHERE (target_type = 'thread' AND target_id = ?)
                 OR (target_type = 'reply' AND target_id IN (
                       SELECT id FROM forum_replies WHERE thread_id = ?
                     ))`,
        args: [threadId, threadId],
      });
      await client.execute({
        sql: `DELETE FROM emoji_reactions
              WHERE (target_type = 'thread' AND target_id = ?)
                 OR (target_type = 'reply' AND target_id IN (
                       SELECT id FROM forum_replies WHERE thread_id = ?
                     ))`,
        args: [threadId, threadId],
      });
      await client.execute({
        sql: 'DELETE FROM forum_replies WHERE thread_id = ?',
        args: [threadId],
      });
      await client.execute({
        sql: 'DELETE FROM forum_threads WHERE id = ?',
        args: [threadId],
      });

      return res.status(200).json({ ok: true });
    }

    // -------- DELETE REPLY --------
    if (action === 'delete-reply') {
      const { id } = req.body || {};
      const replyId = parseInt(id, 10);
      if (!replyId) return res.status(400).json({ error: 'Missing id' });

      const check = await client.execute({
        sql: 'SELECT user_id FROM forum_replies WHERE id = ?',
        args: [replyId],
      });
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Reply not found' });
      }
      if (Number(check.rows[0].user_id) !== user.id && !user.is_admin) {
        return res.status(403).json({ error: 'Not your reply' });
      }

      await client.execute({
        sql: `DELETE FROM forum_votes
              WHERE target_type = 'reply' AND target_id IN (
                SELECT id FROM forum_replies WHERE id = ? OR parent_id = ?
              )`,
        args: [replyId, replyId],
      });
      await client.execute({
        sql: `DELETE FROM emoji_reactions
              WHERE target_type = 'reply' AND target_id IN (
                SELECT id FROM forum_replies WHERE id = ? OR parent_id = ?
              )`,
        args: [replyId, replyId],
      });
      await client.execute({
        sql: 'DELETE FROM forum_replies WHERE parent_id = ?',
        args: [replyId],
      });
      await client.execute({
        sql: 'DELETE FROM forum_replies WHERE id = ?',
        args: [replyId],
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
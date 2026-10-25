import { createClient } from '@libsql/client';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();
  const ip = getClientIp(req);

  try {
    if (await isIpBanned(client, ip)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const action = req.query.action;

    // -------- LIST ALL GROUPS (NEW) --------
    if (action === 'groups') {
      const result = await client.execute('SELECT * FROM forum_groups ORDER BY position ASC');
      return res.status(200).json({ groups: result.rows });
    }

    // -------- LIST ALL CATEGORIES (landing page) --------
    if (action === 'categories') {
      const result = await client.execute(`
        SELECT
          c.id, c.slug, c.name, c.description, c.group_name, c.admin_only, c.position,
          (SELECT COUNT(*) FROM forum_threads t WHERE t.category_id = c.id) AS thread_count,
          (SELECT COUNT(*) FROM forum_replies r
            JOIN forum_threads t2 ON t2.id = r.thread_id
            WHERE t2.category_id = c.id) AS reply_count,
          (SELECT MAX(t3.created_at) FROM forum_threads t3 WHERE t3.category_id = c.id) AS last_thread_at
        FROM forum_categories c
        ORDER BY c.position ASC
      `);

      return res.status(200).json({ categories: result.rows });
    }

    // -------- LIST THREADS IN A CATEGORY --------
    if (action === 'threads') {
      const slug = req.query.category;
      if (!slug) return res.status(400).json({ error: 'Missing category' });

      const catResult = await client.execute({
        sql: 'SELECT id, slug, name, description, group_name, admin_only FROM forum_categories WHERE slug = ?',
        args: [slug],
      });

      if (catResult.rows.length === 0) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const category = catResult.rows[0];

      const threadsResult = await client.execute({
        sql: `SELECT
                t.id, t.title, t.created_at, t.edited_at, t.score,
                u.id AS user_id, u.username, u.display_name,
                (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
              FROM forum_threads t
              JOIN users u ON u.id = t.user_id
              WHERE t.category_id = ?
              ORDER BY t.created_at DESC`,
        args: [category.id],
      });

      return res.status(200).json({
        category,
        threads: threadsResult.rows,
      });
    }

    // -------- SINGLE THREAD WITH REPLIES --------
    if (action === 'thread') {
      const threadId = parseInt(req.query.id, 10);
      if (!threadId) return res.status(400).json({ error: 'Missing id' });

      const threadResult = await client.execute({
        sql: `SELECT
                t.id, t.title, t.body, t.created_at, t.edited_at, t.score, t.category_id,
                u.id AS user_id, u.username, u.display_name,
                c.slug AS category_slug, c.name AS category_name
              FROM forum_threads t
              JOIN users u ON u.id = t.user_id
              JOIN forum_categories c ON c.id = t.category_id
              WHERE t.id = ?`,
        args: [threadId],
      });

      if (threadResult.rows.length === 0) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const thread = threadResult.rows[0];

      const repliesResult = await client.execute({
        sql: `SELECT
                r.id, r.body, r.parent_id, r.created_at, r.edited_at, r.score,
                u.id AS user_id, u.username, u.display_name
              FROM forum_replies r
              JOIN users u ON u.id = r.user_id
              WHERE r.thread_id = ?
              ORDER BY r.created_at ASC`,
        args: [threadId],
      });

      const byId = {};
      const topLevel = [];

      for (const row of repliesResult.rows) {
        byId[row.id] = {
          id: row.id,
          body: row.body,
          parent_id: row.parent_id,
          created_at: row.created_at,
          edited_at: row.edited_at,
          score: Number(row.score) || 0,
          user: {
            id: row.user_id,
            username: row.username,
            display_name: row.display_name || row.username,
          },
          replies: [],
        };
      }

      for (const row of repliesResult.rows) {
        const node = byId[row.id];
        if (row.parent_id && byId[row.parent_id]) {
          byId[row.parent_id].replies.push(node);
        } else {
          topLevel.push(node);
        }
      }

      let userVotes = {};

      const rawCookie = req.headers.cookie || '';
      let token = null;
      for (const part of rawCookie.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === 'ph_session') {
          token = rest.join('=') || null;
          break;
        }
      }

      let user = null;
      if (token) {
        const userResult = await client.execute({
          sql: `SELECT u.id, u.username, u.display_name, u.is_admin
                FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token = ? AND s.expires_at > ?`,
          args: [token, now()],
        });
        if (userResult.rows.length > 0) {
          user = {
            id: userResult.rows[0].id,
            username: userResult.rows[0].username,
            display_name: userResult.rows[0].display_name || userResult.rows[0].username,
            is_admin: !!userResult.rows[0].is_admin,
          };

          const votesResult = await client.execute({
            sql: `SELECT target_type, target_id, value FROM forum_votes
                  WHERE user_id = ? AND (
                    (target_type = 'thread' AND target_id = ?) OR
                    (target_type = 'reply' AND target_id IN (
                      SELECT id FROM forum_replies WHERE thread_id = ?
                    ))
                  )`,
            args: [user.id, threadId, threadId],
          });

          for (const v of votesResult.rows) {
            userVotes[v.target_type + ':' + v.target_id] = Number(v.value);
          }
        }
      }

      return res.status(200).json({
        thread: {
          id: thread.id,
          title: thread.title,
          body: thread.body,
          created_at: thread.created_at,
          edited_at: thread.edited_at,
          score: Number(thread.score) || 0,
          category: {
            slug: thread.category_slug,
            name: thread.category_name,
          },
          user: {
            id: thread.user_id,
            username: thread.username,
            display_name: thread.display_name || thread.username,
          },
        },
        replies: topLevel,
        userVotes,
        user,
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
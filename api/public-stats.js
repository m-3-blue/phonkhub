import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  try {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      throw new Error("Missing Turso environment variables in Vercel.");
    }

    const turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });

    // EXACT SAME LOGIC AS ADMIN PANEL
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [
      usersRes, 
      tracksRes, 
      commentsRes,
      usersTodayRes,
      commentsTodayRes,
      votesTodayRes
    ] = await Promise.all([
      turso.execute('SELECT COUNT(*) as count FROM users'),
      turso.execute('SELECT COUNT(*) as count FROM tracks'),
      turso.execute('SELECT COUNT(*) as count FROM comments'),
      
      // Use the exact same timestamp comparison as the admin panel
      turso.execute({ sql: 'SELECT COUNT(*) as count FROM users WHERE created_at > ?', args: [dayAgo] }),
      turso.execute({ sql: 'SELECT COUNT(*) as count FROM comments WHERE created_at > ?', args: [dayAgo] }),
      turso.execute({ sql: 'SELECT COUNT(*) as count FROM votes WHERE created_at > ?', args: [dayAgo] })
    ]);

    res.status(200).json({
      users: usersRes.rows[0].count,
      tracks: tracksRes.rows[0].count,
      comments: commentsRes.rows[0].count,
      
      usersToday: usersTodayRes.rows[0].count,
      commentsToday: commentsTodayRes.rows[0].count,
      votesToday: votesTodayRes.rows[0].count
    });

  } catch (error) {
    console.error('Stats API Error:', error);
    res.status(500).json({ error: error.message });
  }
}
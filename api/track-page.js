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

// --- THE FIX: Check Authorization header first for Capacitor ---
function getSessionToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const youtubeId = req.query.youtube_id;
  if (!youtubeId) {
    return res.status(400).json({ error: 'Missing youtube_id' });
  }

  const client = getClient();

  try {
    // 1. Fetch the track
    const trackResult = await client.execute({
      sql: 'SELECT id, position, youtube_id, title, artist, tags, category FROM tracks WHERE youtube_id = ?',
      args: [youtubeId],
    });

    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const track = trackResult.rows[0];
    const trackId = track.id;

    // 2. Fetch vote score and user vote
    const scoreResult = await client.execute({
      sql: 'SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE track_id = ?',
      args: [trackId],
    });
    const score = Number(scoreResult.rows[0].score) || 0;

    const user = await getCurrentUser(client, req);
    let userVote = 0;
    if (user) {
      const voteResult = await client.execute({
        sql: 'SELECT value FROM votes WHERE track_id = ? AND user_id = ?',
        args: [trackId, user.id],
      });
      if (voteResult.rows.length > 0) {
        userVote = Number(voteResult.rows[0].value);
      }
    }

    // 3. Fetch recommended tracks
    const recsResult = await client.execute({
      sql: `SELECT id, position, youtube_id, title, artist 
            FROM tracks 
            WHERE id != ? 
            ORDER BY RANDOM() 
            LIMIT 3`,
      args: [trackId],
    });

    return res.status(200).json({
      track: track,
      score: score,
      userVote: userVote,
      user: user,
      recommended: recsResult.rows,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

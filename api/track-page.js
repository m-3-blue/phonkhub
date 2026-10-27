import { createClient } from '@libsql/client';
import cookie from 'cookie';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

// You might need to import your session checker here. 
// Assuming you use a basic session cookie, we'll parse it.
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
    return res.status(400).json({ error: 'youtube_id is required' });
  }

  const client = getClient();

  try {
    // 3. Get the specific track
    const trackResult = await client.execute({
      sql: 'SELECT * FROM tracks WHERE youtube_id = ?',
      args: [youtubeId]
    });
    
    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }
    
    const track = trackResult.rows[0];

    // 4. Get recommended tracks
    const recsResult = await client.execute({
      sql: 'SELECT * FROM tracks WHERE category = ? AND id != ? ORDER BY position ASC LIMIT 10',
      args: [track.category, track.id]
    });
    
    const recommended = recsResult.rows;

    // 5. Get the score for this track
    const scoreResult = await client.execute({
      sql: 'SELECT SUM(value) as score FROM votes WHERE track_id = ?',
      args: [track.id]
    });
    
    let score = 0;
    if (scoreResult.rows.length > 0 && scoreResult.rows[0].score !== null) {
      score = Number(scoreResult.rows[0].score);
    }

    // 6. Parse the auth cookie properly
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionId = cookies.session; // Assuming your cookie is named 'session'
    
    let user = null; 
    let userVote = 0;

    if (sessionId) {
      // Fetch the user based on the session ID
      const userResult = await client.execute({
        sql: `SELECT u.id, u.username, u.display_name 
              FROM users u 
              JOIN sessions s ON u.id = s.user_id 
              WHERE s.id = ?`,
        args: [sessionId]
      });

      if (userResult.rows.length > 0) {
        user = userResult.rows[0];

        // Fetch the user's specific vote for this track
        const voteResult = await client.execute({
          sql: 'SELECT value FROM votes WHERE track_id = ? AND user_id = ?',
          args: [track.id, user.id]
        });

        if (voteResult.rows.length > 0) {
          userVote = voteResult.rows[0].value;
        }
      }
    }

    return res.status(200).json({
      track,
      recommended,
      score,
      user,
      userVote
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

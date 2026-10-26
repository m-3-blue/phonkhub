import { createClient } from '@libsql/client';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export default async function handler(req, res) {
  // 1. Allow requests from the app (localhost, Vercel, or native Capacitor)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();

  try {
    // 3. Get all tracks - Ordered by position
    const tracksResult = await client.execute('SELECT * FROM tracks ORDER BY position ASC');
    
    // 4. Get all track categories
    const catsResult = await client.execute('SELECT * FROM track_categories ORDER BY position ASC');

    // 5. Get scores (aggregate votes)
    const scoresResult = await client.execute(`
      SELECT track_id, SUM(value) as score 
      FROM votes 
      GROUP BY track_id
    `);

    const scores = {};
    scoresResult.rows.forEach(function(row) {
      scores[row.track_id] = Number(row.score);
    });

    return res.status(200).json({
      tracks: tracksResult.rows,
      categories: catsResult.rows,
      scores: scores
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}

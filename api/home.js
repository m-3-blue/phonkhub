import { createClient } from '@libsql/client';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = getClient();

  try {
    // 1. Get all tracks - FIXED: Order by position, not ID!
    const tracksResult = await client.execute('SELECT * FROM tracks ORDER BY position ASC');
    
    // 2. Get all track categories
    const catsResult = await client.execute('SELECT * FROM track_categories ORDER BY position ASC');

    // 3. Get scores (aggregate votes)
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
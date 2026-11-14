import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  // 1. BULLETPROOF CORS SETUP
  const origin = req.headers.origin;

  if (
    !origin || 
    origin === 'null' || 
    origin.startsWith('file://') || 
    origin.includes('localhost') || 
    origin.includes('127.0.0.1') || 
    origin === 'http://tauri.localhost' || 
    origin === 'capacitor://localhost' ||
    origin === 'https://o-phonkhub.vercel.app' ||
    origin === 'https://phonkhub.vercel.app'
  ) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const { id } = req.query;

  try {
    // If an ID is provided, return that track + 3 random recommendations
    if (id) {
      const trackResult = await client.execute({
        sql: 'SELECT * FROM tracks WHERE id = ?',
        args: [id],
      });

      if (trackResult.rows.length === 0) {
        return res.status(404).json({ error: 'Track not found' });
      }

      const recommended = await client.execute({
        sql: 'SELECT * FROM tracks WHERE id != ? ORDER BY RANDOM() LIMIT 3',
        args: [id],
      });

      // Sort the recommendations by position for a cleaner look
      recommended.rows.sort((a, b) => a.position - b.position);

      return res.status(200).json({
        track: trackResult.rows[0],
        recommended: recommended.rows,
      });
    }

    // Otherwise return all tracks — Order by position, not ID!
    const all = await client.execute('SELECT * FROM tracks ORDER BY position ASC');
    return res.status(200).json({ tracks: all.rows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
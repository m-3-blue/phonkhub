import { createClient } from '@libsql/client';

export default async function handler(req, res) {
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

      return res.status(200).json({
        track: trackResult.rows[0],
        recommended: recommended.rows,
      });
    }

    // Otherwise return all tracks
    const all = await client.execute('SELECT * FROM tracks ORDER BY id ASC');
    return res.status(200).json({ tracks: all.rows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

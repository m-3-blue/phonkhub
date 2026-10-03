import { createClient } from '@libsql/client';

function getClient() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, action, track } = req.body || {};

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  // Password is correct from here on

  if (action === 'verify') {
    return res.status(200).json({ ok: true });
  }

  const client = getClient();

  try {
    if (action === 'add') {
      if (!track || !track.id || !track.youtube_id || !track.title || !track.artist) {
        return res.status(400).json({ error: 'Missing fields' });
      }
      await client.execute({
        sql: 'INSERT INTO tracks (id, youtube_id, title, artist) VALUES (?, ?, ?, ?)',
        args: [track.id, track.youtube_id, track.title, track.artist],
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'edit') {
      if (!track || !track.id) {
        return res.status(400).json({ error: 'Missing id' });
      }
      await client.execute({
        sql: 'UPDATE tracks SET youtube_id = ?, title = ?, artist = ? WHERE id = ?',
        args: [track.youtube_id, track.title, track.artist, track.id],
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'delete') {
      if (!track || !track.id) {
        return res.status(400).json({ error: 'Missing id' });
      }
      await client.execute({
        sql: 'DELETE FROM tracks WHERE id = ?',
        args: [track.id],
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
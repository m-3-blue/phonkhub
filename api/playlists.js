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
    sql: `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, username: result.rows[0].username };
}

export default async function handler(req, res) {
  // CORS Setup
  const origin = req.headers.origin;

  if (!origin || origin === 'null' || origin.startsWith('file://') || origin.includes('localhost') || origin === 'capacitor://localhost' || origin.startsWith('app://') || origin.startsWith('tauri://')) {
    // 🪟 Desktop App (Electron/Tauri/Capacitor) & Local dev
    // We use '*' because the desktop app relies on Bearer tokens, NOT cookies.
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // 🌐 Web App
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  const client = getClient();
  const action = req.query.action;
  const user = await getCurrentUser(client, req);

  try {
    // --- FETCH USER'S PLAYLISTS ---
    if (action === 'list' && req.method === 'GET') {
      if (!user) return res.status(401).json({ error: 'Log in first' });
      
      const result = await client.execute({
        sql: `SELECT p.id, p.name, p.created_at, 
              (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
              FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC`,
        args: [user.id]
      });
      return res.status(200).json({ playlists: result.rows });
    }

    // --- FETCH TRACKS IN A PLAYLIST ---
    if (action === 'view' && req.method === 'GET') {
      if (!user) return res.status(401).json({ error: 'Log in first' });
      const playlistId = parseInt(req.query.id, 10);
      if (!playlistId) return res.status(400).json({ error: 'Missing playlist ID' });

      // Ensure they own the playlist
      const ownCheck = await client.execute({ sql: 'SELECT name FROM playlists WHERE id = ? AND user_id = ?', args: [playlistId, user.id] });
      if (ownCheck.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

      const result = await client.execute({
        sql: `SELECT t.id, t.youtube_id, t.title, t.artist, t.position 
              FROM playlist_tracks pt 
              JOIN tracks t ON t.id = pt.track_id 
              WHERE pt.playlist_id = ? ORDER BY pt.added_at DESC`,
        args: [playlistId]
      });

      return res.status(200).json({ 
        playlistName: ownCheck.rows[0].name,
        tracks: result.rows 
      });
    }

    // --- CREATE A NEW PLAYLIST ---
    if (action === 'create' && req.method === 'POST') {
      if (!user) return res.status(401).json({ error: 'Log in first' });
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'Playlist name required' });
      }
      if (name.length > 50) return res.status(400).json({ error: 'Name too long' });

      await client.execute({
        sql: 'INSERT INTO playlists (user_id, name, created_at) VALUES (?, ?, ?)',
        args: [user.id, name.trim(), now()]
      });
      return res.status(200).json({ ok: true });
    }

        // --- DELETE A PLAYLIST ---
    if (action === 'delete' && req.method === 'POST') {
      if (!user) return res.status(401).json({ error: 'Log in first' });
      const { id } = req.body || {};
      const playlistId = parseInt(id, 10);
      
      if (!playlistId) return res.status(400).json({ error: 'Missing playlist ID' });

      // Ensure they own the playlist
      const ownCheck = await client.execute({ sql: 'SELECT id FROM playlists WHERE id = ? AND user_id = ?', args: [playlistId, user.id] });
      if (ownCheck.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

      // Delete all tracks in the playlist first, then the playlist itself
      await client.execute({ sql: 'DELETE FROM playlist_tracks WHERE playlist_id = ?', args: [playlistId] });
      await client.execute({ sql: 'DELETE FROM playlists WHERE id = ?', args: [playlistId] });

      return res.status(200).json({ ok: true });
    }

    // --- CHECK IF TRACK IS IN PLAYLISTS (For the Save Button) ---
    if (action === 'status' && req.method === 'GET') {
      if (!user) return res.status(200).json({ playlists: [] });
      const trackId = parseInt(req.query.track_id, 10);
      if (!trackId) return res.status(400).json({ error: 'Missing track_id' });

      const result = await client.execute({
        sql: `SELECT p.id, p.name, 
              (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = p.id AND pt.track_id = ?) as has_track
              FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC`,
        args: [trackId, user.id]
      });
      return res.status(200).json({ playlists: result.rows });
    }

    // --- TOGGLE TRACK IN A PLAYLIST ---
    if (action === 'toggle' && req.method === 'POST') {
      if (!user) return res.status(401).json({ error: 'Log in first' });
      const { playlist_id, track_id } = req.body || {};
      const plId = parseInt(playlist_id, 10);
      const trId = parseInt(track_id, 10);

      if (!plId || !trId) return res.status(400).json({ error: 'Missing IDs' });

      // Ensure they own the playlist
      const ownCheck = await client.execute({ sql: 'SELECT id FROM playlists WHERE id = ? AND user_id = ?', args: [plId, user.id] });
      if (ownCheck.rows.length === 0) return res.status(403).json({ error: 'Not authorized' });

      const existing = await client.execute({
        sql: 'SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?',
        args: [plId, trId]
      });

      if (existing.rows.length > 0) {
        await client.execute({ sql: 'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', args: [plId, trId] });
        return res.status(200).json({ saved: false });
      } else {
        await client.execute({ sql: 'INSERT INTO playlist_tracks (playlist_id, track_id, added_at) VALUES (?, ?, ?)', args: [plId, trId, now()] });
        return res.status(200).json({ saved: true });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
import { put } from '@vercel/blob';
import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';

function getSessionToken(req) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    const session = await client.execute({
      sql: `SELECT u.id, u.is_admin, u.is_booster FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      args: [token],
    });

    if (session.rows.length === 0) return res.status(401).json({ error: 'Unauthorized' });
    
    const user = session.rows[0];
    if (user.is_admin !== 1 && user.is_booster !== 1) {
      return res.status(403).json({ error: 'Only admins and boosters can upload images.' });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const type = formData.get('type');

    if (!file) return res.status(400).json({ error: 'No file provided' });

    const filename = `${type}-${user.id}-${Date.now()}-${file.name}`;
    const blob = await put(filename, file, { access: 'public' });

    const column = type === 'avatar' ? 'avatar_url' : 'banner_url';
    await client.execute({
      sql: `UPDATE users SET ${column} = ? WHERE id = ?`,
      args: [blob.url, user.id],
    });

    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}
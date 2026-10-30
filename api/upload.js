import { put } from '@vercel/blob';
import { createClient } from '@libsql/client';
import formidable from 'formidable';
import fs from 'fs';

const SESSION_COOKIE = 'ph_session';

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

function now() {
  return new Date().toISOString();
}

// Disable Vercel's built-in body parser so formidable can read the stream
export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    // 1. Verify user
    const session = await client.execute({
      sql: `SELECT u.id, u.is_admin, u.is_booster FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      args: [token, now()],
    });

    if (session.rows.length === 0) return res.status(401).json({ error: 'Session expired' });
    
    const user = session.rows[0];
    if (user.is_admin !== 1 && user.is_booster !== 1) {
      return res.status(403).json({ error: 'Only admins and boosters can upload images.' });
    }

    // 2. Parse form data with formidable
    const form = formidable({});
    const [fields, files] = await form.parse(req);
    
    const file = files.file?.[0];
    const type = fields.type?.[0]; // 'avatar' or 'banner'

    if (!file) return res.status(400).json({ error: 'No file provided' });
    if (type !== 'avatar' && type !== 'banner') return res.status(400).json({ error: 'Invalid type' });

    // 3. Read file from temp path into a buffer
    const fileBuffer = fs.readFileSync(file.filepath);
    const filename = `${type}-${user.id}-${Date.now()}-${file.originalFilename}`;

    // 4. Upload buffer to Vercel Blob
    const blob = await put(filename, fileBuffer, {
      access: 'public',
      contentType: file.mimetype,
      addRandomSuffix: true
    });

    // 5. Update database
    const column = type === 'avatar' ? 'avatar_url' : 'banner_url';
    await client.execute({
      sql: `UPDATE users SET ${column} = ? WHERE id = ?`,
      args: [blob.url, user.id],
    });

    return res.status(200).json({ url: blob.url });

  } catch (err) {
    console.error('Upload Error:', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
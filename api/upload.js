import { put } from '@vercel/blob';
import { createClient } from '@libsql/client';

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

export const config = { 
  api: { bodyParser: false } 
};

export default async function handler(req, res) {
  // 1. CORS Setup
  const ALLOWED_ORIGINS = [
    'https://o-phonkhub.vercel.app',
    'https://phonkhub.vercel.app',
    'https://phonkhub.online',
    'http://localhost:3000',
    'capacitor://localhost'
  ];
  
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    // 2. Verify user is Admin or Booster
    const session = await client.execute({
      sql: `SELECT u.id, u.is_admin, u.is_booster FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      args: [token, now()],
    });

    if (session.rows.length === 0) return res.status(401).json({ error: 'Session expired or invalid' });
    
    const user = session.rows[0];
    if (user.is_admin !== 1 && user.is_booster !== 1) {
      return res.status(403).json({ error: 'Only admins and boosters can upload images.' });
    }

    // 3. Parse the file
    const formData = await req.formData();
    const file = formData.get('file');
    const type = formData.get('type'); // 'avatar' or 'banner'

    if (!file) return res.status(400).json({ error: 'No file provided' });
    if (type !== 'avatar' && type !== 'banner') return res.status(400).json({ error: 'Invalid image type' });

    // 4. Upload to Vercel Blob (OIDC handles authentication automatically)
    const filename = `${type}-${user.id}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;
    const blob = await put(filename, file, { 
      access: 'public',
      addRandomSuffix: true 
    });

    // 5. Save URL to Database
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

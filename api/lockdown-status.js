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

  try {
    const result = await client.execute("SELECT value FROM site_settings WHERE key = 'lockdown'");
    const isLocked = result.rows.length > 0 ? result.rows[0].value : '0';
    return res.status(200).json({ lockdown: isLocked });
  } catch (err) {
    return res.status(200).json({ lockdown: '0' }); 
  }
}
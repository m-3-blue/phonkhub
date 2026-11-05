import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  // Allow Capacitor and Web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
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
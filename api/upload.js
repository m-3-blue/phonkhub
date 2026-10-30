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

// Vercel body parser config (needed for formidable)
export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  // --- 1. CORS HEADERS (Fixes "Failed to fetch" in Capacitor/Localhost) ---
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = getSessionToken(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    // 2. Verify user
    const session = await client.execute({
      sql: `SELECT u.id, u.is_admin, u.is_booster FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
      args: [token, now()],
    });

    if (session.rows.length === 0) return res.status(401).json({ error: 'Session expired' });
    
    const user = session.rows[0];
    if (user.is_admin !== 1 && user.is_booster !== 1) {
      return res.status(403).json({ error: 'Only admins and boosters can upload images.' });
    }

    let fileBuffer;
    let contentType;
    let originalFilename;
    let type;

    // 3. Check Content-Type to see if it's the App (JSON/Base64) or Website (Multipart)
    const contentTypeHeader = req.headers['content-type'] || '';

    if (contentTypeHeader.includes('application/json')) {
      // --- APP FLOW (Base64 JSON) ---
      // In Vercel, if bodyParser is false, we need to manually read the JSON body
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const bodyData = Buffer.concat(buffers).toString();
      const parsedBody = JSON.parse(bodyData);

      const { file, type: imgType, filename } = parsedBody;
      
      if (!file || !imgType) return res.status(400).json({ error: 'Missing file data' });
      if (imgType !== 'avatar' && imgType !== 'banner') return res.status(400).json({ error: 'Invalid type' });

      const base64Data = file.replace(/^data:image\/\w+;base64,/, "");
      fileBuffer = Buffer.from(base64Data, 'base64');
      contentType = 'image/jpeg'; // App sends compressed JPEGs
      originalFilename = filename || 'image.jpg';
      type = imgType;

    } else {
      // --- WEBSITE FLOW (Formidable Multipart) ---
      const form = formidable({});
      const [fields, files] = await form.parse(req);
      
      const fileObj = files.file?.[0];
      type = fields.type?.[0]; 

      if (!fileObj) return res.status(400).json({ error: 'No file provided' });
      if (type !== 'avatar' && type !== 'banner') return res.status(400).json({ error: 'Invalid type' });

      fileBuffer = fs.readFileSync(fileObj.filepath);
      contentType = fileObj.mimetype;
      originalFilename = fileObj.originalFilename;
    }

    // 4. Upload buffer to Vercel Blob
    const finalFilename = `${type}-${user.id}-${Date.now()}-${originalFilename}`;
    const blob = await put(finalFilename, fileBuffer, {
      access: 'public',
      contentType: contentType,
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

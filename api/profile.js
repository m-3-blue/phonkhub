import { createClient } from '@libsql/client';

const SESSION_COOKIE = 'ph_session';
const MAX_BIO = 200;
const MAX_DISPLAY_NAME = 40;
const DEFAULT_ACCENT = '#ff9900';

const VALID_PLATFORMS = ['discord', 'youtube', 'soundcloud', 'twitter', 'instagram', 'spotify'];

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

function isValidAccent(hex) {
  if (typeof hex !== 'string') return false;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;

  var r = parseInt(hex.substr(1, 2), 16);
  var g = parseInt(hex.substr(3, 2), 16);
  var b = parseInt(hex.substr(5, 2), 16);

  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var saturation = max === 0 ? 0 : (max - min) / max;

  return saturation >= 0.25;
}

async function getCurrentUser(client, req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const result = await client.execute({
    sql: `SELECT u.id, u.username, u.display_name, u.bio, u.socials, u.accent_color
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`,
    args: [token, now()],
  });

  if (result.rows.length === 0) return null;

  let socials = {};
  if (result.rows[0].socials) {
    try { socials = JSON.parse(result.rows[0].socials); } catch (e) {}
  }

  return {
    id: result.rows[0].id,
    username: result.rows[0].username,
    display_name: result.rows[0].display_name || result.rows[0].username,
    bio: result.rows[0].bio || '',
    socials: socials,
    accent_color: result.rows[0].accent_color || DEFAULT_ACCENT,
  };
}

export default async function handler(req, res) {
  const client = getClient();

  try {
    if (req.method === 'GET') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in first' });

      return res.status(200).json({
        profile: {
          display_name: user.display_name,
          bio: user.bio,
          socials: user.socials,
          accent_color: user.accent_color,
        },
      });
    }

    if (req.method === 'POST') {
      const user = await getCurrentUser(client, req);
      if (!user) return res.status(401).json({ error: 'Log in first' });

      const { display_name, bio, socials, accent_color } = req.body || {};

      let finalDisplayName = user.display_name;
      if (typeof display_name === 'string' && display_name.trim()) {
        finalDisplayName = display_name.trim().slice(0, MAX_DISPLAY_NAME);
      }

      let finalBio = '';
      if (typeof bio === 'string') {
        finalBio = bio.trim().slice(0, MAX_BIO);
      }

      let finalSocials = {};
      if (socials && typeof socials === 'object' && !Array.isArray(socials)) {
        for (const platform of VALID_PLATFORMS) {
          if (typeof socials[platform] === 'string' && socials[platform].trim()) {
            finalSocials[platform] = socials[platform].trim().slice(0, 120);
          }
        }
      }

      let finalAccent = DEFAULT_ACCENT;
      if (typeof accent_color === 'string' && isValidAccent(accent_color)) {
        finalAccent = accent_color.toLowerCase();
      }

      await client.execute({
        sql: 'UPDATE users SET display_name = ?, bio = ?, socials = ?, accent_color = ? WHERE id = ?',
        args: [finalDisplayName, finalBio, JSON.stringify(finalSocials), finalAccent, user.id],
      });

      return res.status(200).json({
        ok: true,
        profile: {
          display_name: finalDisplayName,
          bio: finalBio,
          socials: finalSocials,
          accent_color: finalAccent,
        },
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
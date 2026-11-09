import { ImageResponse } from '@vercel/og';
import { createClient } from '@libsql/client';

export const config = { runtime: 'edge' };

export default async function handler(req, res) {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const threadId = req.query.id;
  if (!threadId) return res.status(400).send('Missing ID');

  try {
    // 1. Fetch thread data
    const threadRes = await client.execute({
      sql: `SELECT t.title, t.body, t.score, u.username, u.display_name, c.name as category_name 
            FROM forum_threads t 
            JOIN users u ON u.id = t.user_id 
            JOIN forum_categories c ON c.id = t.category_id
            WHERE t.id = ?`,
      args: [threadId]
    });

    if (threadRes.rows.length === 0) return res.status(404).send('Thread not found');
    
    const thread = threadRes.rows[0];
    const author = thread.display_name || thread.username;
    const snippet = thread.body.length > 90 ? thread.body.substring(0, 90) + '...' : thread.body;

    // 2. Draw the custom image using HTML string (No JSX)
    const imageHtml = `
      <div style="height: 100%; width: 100%; display: flex; flex-direction: column; background-color: #080808; padding: 40px; font-family: sans-serif; border-top: 10px solid #ff9900; box-sizing: border-box;">
        
        <!-- Header -->
        <div style="display: flex; align-items: center; margin-bottom: 20px;">
          <img src="https://i.ibb.co/FbnNpjpp/phonk-Hub.png" height="40" />
          <span style="margin-left: 15px; color: #888; font-size: 20px;">r/${thread.category_name}</span>
        </div>

        <!-- Title -->
        <div style="display: flex; color: #f0ece4; font-size: 42px; font-weight: bold; line-height: 1.2; margin-bottom: 15px;">
          ${thread.title}
        </div>

        <!-- Body Snippet -->
        <div style="display: flex; color: #aaaaaa; font-size: 24px; margin-bottom: auto;">
          "${snippet}"
        </div>

        <!-- Footer / Upvotes -->
        <div style="display: flex; align-items: center; color: #ff9900; font-size: 26px; font-weight: bold;">
          <span>▲ ${thread.score} upvotes</span>
          <span style="color: #666; margin-left: 20px; font-weight: normal;">by @${author}</span>
        </div>
      </div>
    `;

    return new ImageResponse(imageHtml, { width: 1200, height: 630 });

  } catch (err) {
    console.error(err);
    return res.status(500).send('Server Error');
  }
}
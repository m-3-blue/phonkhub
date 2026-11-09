import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const threadId = req.query.id;
  if (!threadId) return res.status(400).send('Missing ID');

  try {
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

    // 1. Create a dynamic image URL using a free OG image generator
    // We pass the title and author as URL parameters!
    // We use Microlink to render a custom HTML snippet into an image
    const customHtml = `
      <div style="height: 100vh; width: 100vw; display: flex; flex-direction: column; background-color: #000; border-top: 8px solid #ff9900; padding: 40px; box-sizing: border-box; font-family: sans-serif;">
        <div style="display: flex; align-items: center; margin-bottom: 20px;">
          <img src="https://i.ibb.co/FbnNpjpp/phonk-Hub.png" height="40" />
          <span style="margin-left: 15px; color: #888; font-size: 22px; font-weight: bold; text-transform: uppercase;">r/${thread.category_name}</span>
        </div>
        <div style="display: flex; color: #f0ece4; font-size: 48px; font-weight: 900; line-height: 1.1; text-transform: uppercase; margin-bottom: 15px;">
          ${thread.title}
        </div>
        <div style="display: flex; color: #ff9900; font-size: 20px; font-weight: bold; margin-bottom: 30px;">
           BY ${author.toUpperCase()}
        </div>
        <div style="display: flex; width: 100%; height: 1px; background-color: #222; margin-bottom: 25px;"></div>
        <div style="display: flex; color: #ddd; font-size: 28px; line-height: 1.5; margin-bottom: auto;">
          "${snippet}"
        </div>
        <div style="display: flex; align-items: center; margin-top: auto;">
          <div style="display: flex; align-items: center; background-color: #111; border: 1px solid #333; padding: 10px 20px; border-radius: 4px;">
            <span style="color: #ff9900; font-size: 24px; margin-right: 10px;">▲</span>
            <span style="color: #fff; font-size: 28px; font-weight: bold;">${thread.score}</span>
          </div>
        </div>
      </div>
    `;

    const imageUrl = 'https://i.ibb.co/FbnNpjpp/phonk-Hub.png';
    // 2. Fetch the base HTML
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const htmlRes = await fetch(`${baseUrl}/forum-thread.html`);
    let html = await htmlRes.text();

    // 3. Inject the meta tags
    const metaTags = `
      <meta name="theme-color" content="#ff9900" />
      
      <meta property="og:site_name" content="PhonkHub Forums" />
      <meta property="og:title" content="${thread.title}" />
      <meta property="og:description" content="Posted by ${author} in ${thread.category_name} • ${thread.score} upvotes" />
      <meta property="og:image" content="${imageUrl}" />
      <meta property="og:url" content="https://phonkhub.online/forums/thread-${threadId}" />
      <meta property="og:type" content="article" />
    `;

    html = html.replace('</head>', `${metaTags}</head>`);

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);

  } catch (err) {
    console.error(err);
    return res.status(500).send('Server Error');
  }
}
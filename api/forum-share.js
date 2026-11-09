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

    // Fetch track.html to use as a base template
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const htmlRes = await fetch(`${baseUrl}/forum-thread.html`);
    let html = await htmlRes.text();

    // Inject meta tags
    const metaTags = `
      <meta name="theme-color" content="#ff9900" />
      
      <meta property="og:site_name" content="PhonkHub Forums" />
      <meta property="og:title" content="${thread.title}" />
      <meta property="og:description" content="Posted by ${author} • ▲ ${thread.score} upvotes in ${thread.category_name}" />
      <meta property="og:image" content="https://i.ibb.co/FbnNpjpp/phonk-Hub.png" />
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
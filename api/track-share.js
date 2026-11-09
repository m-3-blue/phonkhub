import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const youtubeId = req.query.youtube_id;
  if (!youtubeId) return res.status(400).send('Missing ID');

  try {
    const trackRes = await client.execute({
      sql: `SELECT t.title, t.artist, t.position, COALESCE((SELECT SUM(value) FROM votes WHERE track_id = t.id), 0) AS score 
            FROM tracks t WHERE t.youtube_id = ?`,
      args: [youtubeId]
    });

    if (trackRes.rows.length === 0) return res.status(404).send('Track not found');

    const track = trackRes.rows[0];
    const title = `${track.title}`;
    const description = `by ${track.artist}\n\nRanked #${track.position} on PhonkHub with ${track.score} upvotes. Listen now!`;
    const imageUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;

    // We fetch the raw HTML of track.html from your site
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
    const htmlRes = await fetch(`${baseUrl}/track.html`);
    let html = await htmlRes.text();

    const metaTags = `
      <meta name="theme-color" content="#ff9900" />
      
      <meta property="og:site_name" content="PhonkHub" />
      <meta property="og:title" content="${track.title}" />
      <meta property="og:description" content="by ${track.artist} • Ranked #${track.position}" />
      
      <!-- THIS IS THE MAGIC PART -->
      <meta property="og:image" content="${imageUrl}" />
      <meta property="og:type" content="video.other" />
      <meta property="og:video:url" content="https://www.youtube.com/embed/${youtubeId}" />
      <meta property="og:video:secure_url" content="https://www.youtube.com/embed/${youtubeId}" />
      <meta property="og:video:type" content="text/html" />
      <meta property="og:video:width" content="1280" />
      <meta property="og:video:height" content="720" />
      
      <meta property="og:url" content="https://phonkhub.online/track/${youtubeId}" />
    `;

    // Inject the tags right before </head>
    html = html.replace('</head>', `${metaTags}</head>`);

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).send('Server Error');
  }
}
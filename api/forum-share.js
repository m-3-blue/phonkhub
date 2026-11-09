import { ImageResponse } from '@vercel/og';
import { createClient } from '@libsql/client';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get('id');
  
  if (!threadId) return new Response('Missing ID', { status: 400 });

  try {
    const threadRes = await client.execute({
      sql: `SELECT t.title, t.body, t.score, u.username, u.display_name, c.name as category_name 
            FROM forum_threads t 
            JOIN users u ON u.id = t.user_id 
            JOIN forum_categories c ON c.id = t.category_id
            WHERE t.id = ?`,
      args: [threadId]
    });

    if (threadRes.rows.length === 0) return new Response('Thread not found', { status: 404 });
    
    const thread = threadRes.rows[0];
    const author = thread.display_name || thread.username;
    const snippet = thread.body.length > 90 ? thread.body.substring(0, 90) + '...' : thread.body;

    // This is the actual drawing part
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#000000', // Pure black background
            borderTop: '8px solid #ff9900', // PhonkHub Orange top border
            padding: '40px',
            fontFamily: 'sans-serif',
          }}
        >
          {/* Header: Logo & Category */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
            <img src="https://i.ibb.co/FbnNpjpp/phonk-Hub.png" height="40" style={{ marginRight: '15px' }} />
            <span style={{ color: '#888', fontSize: '22px', fontWeight: 'bold', textTransform: 'uppercase' }}>
              r/{thread.category_name}
            </span>
          </div>

          {/* Title */}
          <div style={{ 
            display: 'flex', 
            color: '#f0ece4', 
            fontSize: '48px', 
            fontWeight: '900', 
            lineHeight: 1.1, 
            textTransform: 'uppercase',
            marginBottom: '15px' 
          }}>
            {thread.title}
          </div>

          {/* Author & Time */}
          <div style={{ display: 'flex', color: '#ff9900', fontSize: '20px', fontWeight: 'bold', marginBottom: '30px' }}>
             BY {author.toUpperCase()}
             <span style={{ color: '#666', marginLeft: '20px', fontWeight: 'normal' }}>JUST NOW</span>
          </div>

          {/* Divider Line */}
          <div style={{ display: 'flex', width: '100%', height: '1px', backgroundColor: '#222', marginBottom: '25px' }}></div>

          {/* Body Snippet */}
          <div style={{ 
            display: 'flex', 
            color: '#dddddd', 
            fontSize: '28px', 
            lineHeight: 1.5,
            marginBottom: 'auto' 
          }}>
            "{snippet}"
          </div>

          {/* Footer: Votes */}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#111', border: '1px solid #333', padding: '10px 20px', borderRadius: '4px' }}>
              <span style={{ color: '#ff9900', fontSize: '24px', marginRight: '10px' }}>▲</span>
              <span style={{ color: '#fff', fontSize: '28px', fontWeight: 'bold' }}>{thread.score}</span>
              <span style={{ color: '#ff9900', fontSize: '24px', marginLeft: '10px' }}>▼</span>
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );

  } catch (err) {
    console.error(err);
    return new Response('Server Error', { status: 500 });
  }
}
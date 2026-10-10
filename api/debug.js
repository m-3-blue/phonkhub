export default function handler(req, res) {
  res.status(200).json({
    'x-forwarded-for': req.headers['x-forwarded-for'] || null,
    'x-real-ip': req.headers['x-real-ip'] || null,
    'x-vercel-forwarded-for': req.headers['x-vercel-forwarded-for'] || null,
    'x-vercel-ip-city': req.headers['x-vercel-ip-city'] || null,
    'x-vercel-ip-country': req.headers['x-vercel-ip-country'] || null,
    'socketRemoteAddress': req.socket ? req.socket.remoteAddress : null,
  });
}
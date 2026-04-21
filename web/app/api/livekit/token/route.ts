export const runtime = 'nodejs';

export async function POST(req: Request) {
  let body: any = {};

  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const serverBase = process.env.PY_SERVER_URL || 'http://localhost:8001';
  const serverPath = process.env.PY_LIVEKIT_TOKEN_PATH || '/api/v1/livekit/token';
  const url = `${serverBase.replace(/\/$/, '')}${serverPath}`;

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8' },
    });
  } catch (e: any) {
    console.error('[livekit-token-proxy] upstream error', e);
    return new Response(JSON.stringify({ error: e?.message || 'Upstream error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}

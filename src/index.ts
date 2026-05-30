export interface Env {}

// ── Token encoding ─────────────────────────────────────────────────────────
// Token = base64url( UTF-8( JSON({u, e}) ) )
// u: target URL, e: expiry unix timestamp (seconds)
// Default TTL: 24 hours

const TOKEN_TTL_SECONDS = 86400;

function encodeToken(url: string): string {
  const payload = JSON.stringify({ u: url, e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS });
  const bytes = new TextEncoder().encode(payload);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeToken(token: string): { url: string } | null {
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed.u || typeof parsed.u !== 'string') return null;
    if (typeof parsed.e === 'number' && parsed.e < Math.floor(Date.now() / 1000)) return null;
    return { url: parsed.u };
  } catch {
    return null;
  }
}

// ── URL validation ─────────────────────────────────────────────────────────

function validateUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Invalid URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return 'Only http:// and https:// URLs are supported';
  }
  const h = url.hostname;
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    return 'Private/internal addresses are not supported';
  }
  return null;
}

// ── Headers ────────────────────────────────────────────────────────────────

// Headers forwarded from client to upstream (needed for Range/resume)
const UPSTREAM_FORWARD_HEADERS = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'accept-encoding',
];

// Headers forwarded from upstream to client
const DOWNSTREAM_FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-encoding',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'expires',
];

function buildUpstreamHeaders(incoming: Headers): Headers {
  const out = new Headers();
  out.set('User-Agent', 'Mozilla/5.0 (compatible; cf-download-proxy/1.0)');
  for (const h of UPSTREAM_FORWARD_HEADERS) {
    const v = incoming.get(h);
    if (v) out.set(h, v);
  }
  return out;
}

function buildDownstreamHeaders(upstream: Headers, originalUrl: string, finalUrl: string): Headers {
  const out = new Headers();
  for (const h of DOWNSTREAM_FORWARD_HEADERS) {
    const v = upstream.get(h);
    if (v) out.set(h, v);
  }

  // Fix Content-Disposition when upstream omits the filename (or sets
  // "attachment" with no filename= parameter). Browsers would otherwise
  // save the file as "dl" (the proxy path segment).
  const cd = out.get('content-disposition') ?? '';
  const hasFilename = /filename\s*=/i.test(cd);
  if (!hasFilename) {
    const filename = extractFilename(finalUrl) ?? extractFilename(originalUrl);
    if (filename) {
      const safe = filename.replace(/["\\]/g, '_');
      if (cd) {
        // Append filename to existing "attachment" directive
        out.set('Content-Disposition', `${cd}; filename="${safe}"`);
      } else {
        out.set('Content-Disposition', `attachment; filename="${safe}"`);
      }
    }
  }

  out.set('Access-Control-Allow-Origin', '*');
  return out;
}

function extractFilename(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split('/').filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

// ── Proxy handler ──────────────────────────────────────────────────────────

async function handleProxy(token: string, request: Request): Promise<Response> {
  if (!token) {
    return new Response('Missing token parameter "t"', { status: 400 });
  }

  const decoded = decodeToken(token);
  if (!decoded) {
    return new Response('Invalid or expired token', { status: 400 });
  }

  const validationError = validateUrl(decoded.url);
  if (validationError) {
    return new Response(validationError, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(decoded.url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: buildUpstreamHeaders(request.headers),
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Upstream fetch failed: ${err}`, { status: 502 });
  }

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: buildDownstreamHeaders(upstream.headers, decoded.url, upstream.url),
  });
}

// ── Encode API ─────────────────────────────────────────────────────────────

const INTL_HOST = 'dl.lihongjie.cn';
const DOMESTIC_HOST = 'dl.cn.lihongjie.cn';

async function handleEncode(request: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const raw = (body.url ?? '').trim();
  if (!raw) {
    return new Response(JSON.stringify({ error: 'url is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const validationError = validateUrl(raw);
  if (validationError) {
    return new Response(JSON.stringify({ error: validationError }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = encodeToken(raw);
  const expiresAt = new Date((Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS) * 1000).toISOString();

  return new Response(
    JSON.stringify({
      token,
      international: `https://${INTL_HOST}/dl?t=${token}`,
      domestic: `https://${DOMESTIC_HOST}/dl?t=${token}`,
      expires_at: expiresAt,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    },
  );
}

// ── Landing page ───────────────────────────────────────────────────────────

function handleIndex(): Response {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>⚡ 下载加速 - lihongjie.cn</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fa;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
    .container{width:100%;max-width:700px}
    h1{font-size:2em;font-weight:700;color:#1a1a2e;margin-bottom:6px;text-align:center}
    .subtitle{color:#666;text-align:center;margin-bottom:32px;font-size:.95em}
    .form-row{display:flex;gap:10px;margin-bottom:24px}
    input{flex:1;padding:12px 16px;border:2px solid #e2e8f0;border-radius:10px;font-size:1em;outline:none;transition:border-color .2s;background:#fff}
    input:focus{border-color:#4f46e5}
    button.btn-primary{padding:12px 22px;background:#4f46e5;color:#fff;border:none;border-radius:10px;font-size:1em;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .2s}
    button.btn-primary:hover{background:#4338ca}
    button.btn-primary:disabled{background:#a5b4fc;cursor:not-allowed}
    #result{display:none;flex-direction:column;gap:14px}
    .card{background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
    .card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .card-label{font-weight:600;font-size:.95em;color:#333}
    .card-ttl{font-size:.78em;color:#999}
    .url-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:.82em;word-break:break-all;color:#374151;margin-bottom:10px;line-height:1.5}
    .card-actions{display:flex;gap:8px}
    button.btn-copy{padding:7px 16px;background:#f1f5f9;color:#374151;border:1px solid #e2e8f0;border-radius:7px;font-size:.85em;cursor:pointer;transition:background .15s}
    button.btn-copy:hover{background:#e2e8f0}
    button.btn-copy.copied{background:#dcfce7;border-color:#bbf7d0;color:#166534}
    a.btn-open{padding:7px 16px;background:#4f46e5;color:#fff;border-radius:7px;font-size:.85em;text-decoration:none;font-weight:500;display:inline-block;transition:background .15s}
    a.btn-open:hover{background:#4338ca}
    #error{color:#dc2626;font-size:.9em;margin-top:8px;display:none}
    .examples{margin-top:28px;font-size:.82em;color:#999;text-align:center;line-height:1.8}
    .examples span{color:#6366f1;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
    footer{margin-top:36px;color:#bbb;font-size:.8em;text-align:center}
  </style>
</head>
<body>
<div class="container">
  <h1>⚡ 下载加速</h1>
  <p class="subtitle">输入文件直链，生成国内外加速地址（链接 24 小时有效）</p>

  <div class="form-row">
    <input type="url" id="urlInput" placeholder="https://github.com/.../releases/download/..." autocomplete="off" autofocus>
    <button class="btn-primary" id="genBtn" onclick="generate()">生成链接</button>
  </div>
  <div id="error"></div>

  <div id="result">
    <div class="card">
      <div class="card-header">
        <span class="card-label">🌍 国际线路</span>
        <span class="card-ttl" id="ttlText"></span>
      </div>
      <div class="url-box" id="intlUrl"></div>
      <div class="card-actions">
        <button class="btn-copy" id="intlCopy" onclick="copy('intlUrl','intlCopy')">复制链接</button>
        <a class="btn-open" id="intlOpen" href="#" target="_blank">直接下载</a>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-label">🇨🇳 国内优选</span>
        <span class="card-ttl"></span>
      </div>
      <div class="url-box" id="cnUrl"></div>
      <div class="card-actions">
        <button class="btn-copy" id="cnCopy" onclick="copy('cnUrl','cnCopy')">复制链接</button>
        <a class="btn-open" id="cnOpen" href="#" target="_blank">直接下载</a>
      </div>
    </div>
  </div>

  <div class="examples">
    示例：
    <span onclick="fillExample('https://github.com/cli/cli/releases/download/v2.50.0/gh_2.50.0_linux_amd64.tar.gz')">GitHub Release</span> ·
    <span onclick="fillExample('https://nodejs.org/dist/v22.3.0/node-v22.3.0-linux-x64.tar.xz')">Node.js 安装包</span> ·
    <span onclick="fillExample('https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb')">Chrome .deb</span>
  </div>

  <footer>Powered by Cloudflare Workers · <a href="https://github.com/lihongjie0209/cf-download-proxy" style="color:#bbb">Source</a></footer>
</div>

<script>
  function fillExample(url) {
    document.getElementById('urlInput').value = url;
    generate();
  }

  async function generate() {
    const raw = document.getElementById('urlInput').value.trim();
    const errEl = document.getElementById('error');
    const btn = document.getElementById('genBtn');
    errEl.style.display = 'none';
    if (!raw) { errEl.textContent = '请输入下载地址'; errEl.style.display = 'block'; return; }

    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const res = await fetch('/api/encode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || '生成失败，请检查链接格式';
        errEl.style.display = 'block';
        return;
      }
      document.getElementById('intlUrl').textContent = data.international;
      document.getElementById('cnUrl').textContent = data.domestic;
      document.getElementById('intlOpen').href = data.international;
      document.getElementById('cnOpen').href = data.domestic;
      const exp = new Date(data.expires_at);
      document.getElementById('ttlText').textContent = '有效期至 ' + exp.toLocaleString('zh-CN');
      document.getElementById('result').style.display = 'flex';
    } catch (e) {
      errEl.textContent = '请求失败：' + e.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '生成链接';
    }
  }

  function copy(urlId, btnId) {
    const text = document.getElementById(urlId).textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById(btnId);
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '复制链接'; btn.classList.remove('copied'); }, 2000);
    });
  }

  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') generate();
  });
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '') {
      return handleIndex();
    }

    if (path === '/api/encode') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      return handleEncode(request);
    }

    if (path === '/dl') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          },
        });
      }
      return handleProxy(url.searchParams.get('t') ?? '', request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

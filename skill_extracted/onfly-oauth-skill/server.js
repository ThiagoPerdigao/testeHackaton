const express = require('express');
const axios = require('axios');
const net = require('net');

// ── Config ──────────────────────────────────────────
var CONFIG = {
  apiUrl: 'https://api.onfly.com',
  appUrl: 'https://app.onfly.com',
  gatewayUrl: 'https://toguro-app-prod.onfly.com',
  clientId: process.env.CLIENT_ID || '1212',
  clientSecret: process.env.CLIENT_SECRET || 'fLWgKiTE4qmkx7pXwfEcTB7yNjKiisygEbbinWEV',
  preferredPort: parseInt(process.env.PORT) || 3333,
  state: 'onfly_' + Math.random().toString(36).substring(2, 10)
};

// ── Token store (in-memory) ─────────────────────────
var tokenStore = {
  // Passport (API) tokens
  access_token: null,
  refresh_token: null,
  expires_at: null,
  user: null,
  // Gateway tokens
  gateway_token: null,
  gateway_refresh_token: null,
  gateway_expires_at: null
};

// ── Helpers ─────────────────────────────────────────
function isPortFree(port) {
  return new Promise(function (resolve) {
    var server = net.createServer();
    server.once('error', function () { resolve(false); });
    server.once('listening', function () { server.close(function () { resolve(true); }); });
    server.listen(port);
  });
}

async function findPort(preferred) {
  if (await isPortFree(preferred)) return preferred;
  for (var i = 0; i < 20; i++) {
    var port = 3000 + Math.floor(Math.random() * 6000);
    if (await isPortFree(port)) return port;
  }
  return 0;
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  } catch (e) { return null; }
}

function isTokenExpired() {
  if (!tokenStore.expires_at) return true;
  return Date.now() > tokenStore.expires_at - 60000;
}

function isGatewayTokenExpired() {
  if (!tokenStore.gateway_expires_at) return true;
  return Date.now() > tokenStore.gateway_expires_at - 60000;
}

async function refreshAccessToken() {
  if (!tokenStore.refresh_token) return false;
  try {
    var resp = await axios.post(CONFIG.apiUrl + '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tokenStore.refresh_token,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret
    }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } });

    tokenStore.access_token = resp.data.access_token;
    if (resp.data.refresh_token) tokenStore.refresh_token = resp.data.refresh_token;
    tokenStore.expires_at = Date.now() + (resp.data.expires_in * 1000);
    return true;
  } catch (e) {
    return false;
  }
}

// Obtém token do gateway via API interna
async function fetchGatewayToken() {
  if (isTokenExpired()) {
    var refreshed = await refreshAccessToken();
    if (!refreshed) return { error: true, message: 'Passport token expirado e refresh falhou.' };
  }
  try {
    var resp = await axios.get(CONFIG.apiUrl + '/v1/auth/token/internal', {
      headers: {
        'Authorization': 'Bearer ' + tokenStore.access_token,
        'Accept': 'application/prs.onfly.v1+json'
      }
    });
    tokenStore.gateway_token = resp.data.token;
    tokenStore.gateway_refresh_token = resp.data.refreshToken || null;
    // Gateway tokens duram ~15 min
    tokenStore.gateway_expires_at = Date.now() + (15 * 60 * 1000);
    return { error: false };
  } catch (e) {
    var errData = e.response ? e.response.data : { message: e.message };
    return { error: true, message: 'Falha ao obter gateway token', data: errData };
  }
}

// Garante que o gateway token está válido
async function ensureGatewayToken() {
  if (!tokenStore.gateway_token || isGatewayTokenExpired()) {
    return await fetchGatewayToken();
  }
  return { error: false };
}

// Chamada para a API (Passport)
async function apiCall(method, path, params) {
  if (isTokenExpired()) {
    var refreshed = await refreshAccessToken();
    if (!refreshed) return { error: true, data: { message: 'Token expirado e refresh falhou. Reconecte.' } };
  }
  try {
    var config = {
      method: method,
      url: CONFIG.apiUrl + path,
      headers: {
        'Authorization': 'Bearer ' + tokenStore.access_token,
        'Accept': 'application/prs.onfly.v1+json'
      }
    };
    if (params) config.params = params;
    var resp = await axios(config);
    return { error: false, data: resp.data };
  } catch (e) {
    return { error: true, data: e.response ? e.response.data : { message: e.message } };
  }
}

// Chamada para o Gateway (EdDSA token)
async function gatewayCall(method, path, body) {
  var gwResult = await ensureGatewayToken();
  if (gwResult.error) return { error: true, data: gwResult };

  try {
    var config = {
      method: method,
      url: CONFIG.gatewayUrl + path,
      headers: {
        'Authorization': 'Bearer ' + tokenStore.gateway_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };
    if (body) config.data = body;
    var resp = await axios(config);
    return { error: false, data: resp.data };
  } catch (e) {
    // Se token expirou no gateway, tenta renovar uma vez
    if (e.response && (e.response.status === 401 || (e.response.data && e.response.data.code === 'invalid_token_provided'))) {
      var retryResult = await fetchGatewayToken();
      if (retryResult.error) return { error: true, data: retryResult };
      try {
        config.headers['Authorization'] = 'Bearer ' + tokenStore.gateway_token;
        var resp2 = await axios(config);
        return { error: false, data: resp2.data };
      } catch (e2) {
        return { error: true, data: e2.response ? e2.response.data : { message: e2.message } };
      }
    }
    return { error: true, data: e.response ? e.response.data : { message: e.message } };
  }
}

// ── Styles ──────────────────────────────────────────
var STYLE = `
  :root { --bg:#0f172a; --surface:#1e293b; --surface2:#334155; --accent:#3b82f6; --accent2:#60a5fa; --text:#f1f5f9; --text2:#94a3b8; --success:#22c55e; --error:#ef4444; --border:#475569; --warn:#f59e0b; --gw:#8b5cf6; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
  .page { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .page-scroll { padding:40px 24px; max-width:960px; margin:0 auto; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:32px; margin-bottom:20px; }
  .logo { display:flex; align-items:center; gap:10px; margin-bottom:24px; }
  .logo-icon { width:36px; height:36px; background:var(--accent); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:bold; color:#fff; }
  .logo-text { font-size:18px; font-weight:700; }
  .logo-badge { font-size:10px; background:var(--surface2); color:var(--text2); padding:2px 8px; border-radius:4px; }
  h1 { font-size:24px; font-weight:700; margin-bottom:8px; }
  h2 { font-size:15px; font-weight:600; color:var(--accent2); margin-bottom:12px; }
  .sub { color:var(--text2); margin-bottom:20px; font-size:14px; line-height:1.5; }
  .btn { display:inline-flex; align-items:center; gap:8px; padding:12px 24px; background:var(--accent); color:#fff; text-decoration:none; border-radius:8px; font-size:14px; font-weight:600; transition:all .2s; border:none; cursor:pointer; }
  .btn:hover { background:var(--accent2); }
  .btn-sm { padding:8px 16px; font-size:13px; }
  .btn-warn { background:var(--warn); color:#000; }
  .btn-err { background:var(--error); }
  .btn-gw { background:var(--gw); }
  .btn-gw:hover { background:#a78bfa; }
  .nav { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:20px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:5px; font-size:11px; font-weight:700; }
  .badge-ok { background:#064e3b; color:#6ee7b7; }
  .badge-err { background:#4c0519; color:#fda4af; }
  .badge-warn { background:#78350f; color:#fde68a; }
  .badge-gw { background:#3b0764; color:#c4b5fd; }
  .token-box { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--accent2); word-break:break-all; margin:8px 0; max-height:80px; overflow:auto; }
  .json-box { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:16px; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--text2); word-break:break-all; max-height:400px; overflow:auto; white-space:pre-wrap; line-height:1.6; }
  .stat { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:var(--surface2); border-radius:6px; font-size:12px; margin-right:8px; margin-bottom:8px; }
  .stat b { color:var(--accent2); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:10px 12px; background:var(--surface2); color:var(--text2); font-weight:600; font-size:12px; text-transform:uppercase; }
  td { padding:10px 12px; border-bottom:1px solid var(--border); }
  tr:hover td { background:var(--surface2); }
  .empty { text-align:center; padding:40px; color:var(--text2); }
  .user-bar { display:flex; align-items:center; gap:12px; padding:12px 16px; background:var(--surface2); border-radius:10px; margin-bottom:16px; }
  .avatar { width:40px; height:40px; border-radius:8px; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:700; flex-shrink:0; }
  .user-info { flex:1; }
  .user-name { font-size:14px; font-weight:600; }
  .user-email { font-size:12px; color:var(--text2); }
  .back { display:inline-flex; align-items:center; gap:6px; color:var(--accent2); text-decoration:none; font-size:13px; }
  .back:hover { text-decoration:underline; }
  .form-group { margin-bottom:16px; }
  .form-group label { display:block; font-size:13px; font-weight:600; color:var(--text2); margin-bottom:6px; }
  .form-group input, .form-group select { width:100%; padding:10px 14px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:14px; font-family:inherit; }
  .form-group input:focus, .form-group select:focus { outline:none; border-color:var(--accent); }
  .form-row { display:flex; gap:12px; }
  .form-row .form-group { flex:1; }
  .section-title { font-size:13px; font-weight:700; color:var(--gw); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; padding-bottom:6px; border-bottom:1px solid var(--border); }
  .flight-card { background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:12px; }
  .flight-route { font-size:16px; font-weight:700; margin-bottom:4px; }
  .flight-detail { font-size:12px; color:var(--text2); }
  .flight-price { font-size:18px; font-weight:700; color:var(--success); }
  .tab-bar { display:flex; gap:0; margin-bottom:20px; border-bottom:2px solid var(--border); }
  .tab { padding:10px 20px; font-size:13px; font-weight:600; color:var(--text2); text-decoration:none; border-bottom:2px solid transparent; margin-bottom:-2px; }
  .tab:hover { color:var(--text); }
  .tab.active { color:var(--accent2); border-bottom-color:var(--accent2); }
`;

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Onfly Skill</title>
<style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

function logoHtml() {
  return `<div class="logo">
    <div class="logo-icon">O</div>
    <span class="logo-text">Onfly</span>
    <span class="logo-badge">OAuth Skill</span>
  </div>`;
}

// ── App ─────────────────────────────────────────────
var app = express();
app.use(express.urlencoded({ extended: true }));

// HOME
app.get('/', function (req, res) {
  if (tokenStore.access_token && !isTokenExpired()) {
    return res.redirect('/dashboard');
  }

  var redirectUri = 'http://localhost:' + actualPort + '/callback';
  var authorizeUrl = CONFIG.appUrl + '/v2#/auth/oauth/authorize'
    + '?client_id=' + encodeURIComponent(CONFIG.clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&state=' + encodeURIComponent(CONFIG.state);

  res.send(layout('Conectar', `
<div class="page">
  <div class="card" style="max-width:480px;width:100%;">
    ${logoHtml()}
    <h1>Conecte sua conta Onfly</h1>
    <p class="sub">Autorize o acesso para consultar viagens, reservas e buscar voos via OAuth + Gateway.</p>
    <a href="${authorizeUrl}" class="btn">Conectar com Onfly</a>
    <hr style="border:none;border-top:1px solid var(--border);margin:20px 0;">
    <div style="font-size:12px;color:var(--text2);line-height:1.6;">
      <div><b>client_id:</b> ${CONFIG.clientId}</div>
      <div><b>redirect_uri:</b> ${redirectUri}</div>
      <div><b>gateway:</b> ${CONFIG.gatewayUrl}</div>
      <div><b>state:</b> ${CONFIG.state}</div>
    </div>
  </div>
</div>`));
});

// CALLBACK
app.get('/callback', async function (req, res) {
  var code = req.query.code;
  var state = req.query.state;
  var error = req.query.error;

  if (error) {
    return res.send(layout('Negado', `<div class="page"><div class="card" style="max-width:480px;">
      ${logoHtml()}<h1 style="color:var(--error)">Acesso negado</h1>
      <p class="sub">${req.query.error_description || 'O usuario nao autorizou.'}</p>
      <a href="/" class="back">Voltar</a></div></div>`));
  }

  if (state !== CONFIG.state) {
    return res.send(layout('Erro', `<div class="page"><div class="card" style="max-width:480px;">
      ${logoHtml()}<h1 style="color:var(--error)">State mismatch</h1>
      <p class="sub">Possivel CSRF. State esperado: ${CONFIG.state}, recebido: ${state}</p>
      <a href="/" class="back">Voltar</a></div></div>`));
  }

  // Troca code por Passport token
  var redirectUri = 'http://localhost:' + actualPort + '/callback';
  try {
    var tokenResp = await axios.post(CONFIG.apiUrl + '/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      redirect_uri: redirectUri
    }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } });

    tokenStore.access_token = tokenResp.data.access_token;
    tokenStore.refresh_token = tokenResp.data.refresh_token || null;
    tokenStore.expires_at = Date.now() + ((tokenResp.data.expires_in || 3600) * 1000);

    // Busca dados do usuario
    var payload = decodeJwt(tokenStore.access_token);
    if (payload && payload.sub) {
      var userResp = await apiCall('GET', '/employees/' + payload.sub, { userId: payload.sub, paginate: false, include: 'permissions' });
      if (!userResp.error) {
        var ud = userResp.data.data || userResp.data;
        tokenStore.user = {
          id: ud.id || payload.sub,
          name: ud.first_name || ud.name || '',
          email: ud.email || '',
          company: (ud.company && ud.company.social_name) || ''
        };
      }
    }

    // Obtém gateway token automaticamente
    await fetchGatewayToken();

    return res.redirect('/dashboard');
  } catch (e) {
    var errData = e.response ? e.response.data : { message: e.message };
    return res.send(layout('Erro', `<div class="page"><div class="card" style="max-width:560px;">
      ${logoHtml()}<h1 style="color:var(--error)">Erro no token exchange</h1>
      <p class="sub">Nao foi possivel trocar o authorization code por um token.</p>
      <div class="json-box">${JSON.stringify(errData, null, 2)}</div>
      <br><a href="/" class="back">Tentar novamente</a></div></div>`));
  }
});

// DASHBOARD
app.get('/dashboard', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var expired = isTokenExpired();
  var gwExpired = isGatewayTokenExpired();
  var payload = decodeJwt(tokenStore.access_token);
  var user = tokenStore.user || {};
  var initial = user.name ? user.name.charAt(0).toUpperCase() : 'U';

  var expiresIn = tokenStore.expires_at ? Math.max(0, Math.floor((tokenStore.expires_at - Date.now()) / 60000)) : '?';
  var gwExpiresIn = tokenStore.gateway_expires_at ? Math.max(0, Math.floor((tokenStore.gateway_expires_at - Date.now()) / 60000)) : '?';

  res.send(layout('Dashboard', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <div class="user-bar">
      <div class="avatar">${initial}</div>
      <div class="user-info">
        <div class="user-name">${user.name || 'Usuario'}</div>
        <div class="user-email">${user.email || ''}</div>
      </div>
      <span class="badge ${expired ? 'badge-err' : 'badge-ok'}">${expired ? 'EXPIRADO' : 'API ATIVO'}</span>
      <span class="badge ${gwExpired || !tokenStore.gateway_token ? 'badge-err' : 'badge-gw'}">${!tokenStore.gateway_token ? 'GW N/A' : gwExpired ? 'GW EXPIRADO' : 'GW ATIVO'}</span>
    </div>
    <div>
      <span class="stat"><b>user_id:</b> ${payload ? payload.sub : '?'}</span>
      <span class="stat"><b>empresa:</b> ${user.company || '?'}</span>
      <span class="stat"><b>API expira em:</b> ${expiresIn} min</span>
      <span class="stat"><b>GW expira em:</b> ${tokenStore.gateway_token ? gwExpiresIn + ' min' : 'N/A'}</span>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Gateway v3 (toguro)</div>
    <p class="sub">Endpoints do gateway usando token EdDSA interno</p>
    <div class="nav">
      <a href="/bookings" class="btn btn-sm btn-gw">Reservas (Bookings)</a>
      <a href="/flight-search" class="btn btn-sm btn-gw">Buscar Voos</a>
      <a href="/gateway-token" class="btn btn-sm btn-gw">Gateway Token Info</a>
    </div>
  </div>

  <div class="card">
    <div class="section-title">API Direta (Passport)</div>
    <p class="sub">Endpoints da API usando token Passport</p>
    <div class="nav">
      <a href="/travels" class="btn btn-sm">Viagens Aereas</a>
      <a href="/hotel-orders" class="btn btn-sm">Hospedagens</a>
      <a href="/user-info" class="btn btn-sm">Dados do Usuario</a>
    </div>
  </div>

  <div class="card">
    <div class="nav">
      <a href="/refresh" class="btn btn-sm btn-warn">Refresh Passport Token</a>
      <a href="/refresh-gateway" class="btn btn-sm btn-warn">Refresh Gateway Token</a>
      <a href="/disconnect" class="btn btn-sm btn-err">Desconectar</a>
    </div>
  </div>

  <div class="card">
    <h2>Passport Access Token (JWT RS256)</h2>
    <div class="token-box">${tokenStore.access_token ? tokenStore.access_token.substring(0, 120) + '...' : 'N/A'}</div>
    ${tokenStore.gateway_token ? '<h2>Gateway Token (EdDSA)</h2><div class="token-box">' + tokenStore.gateway_token.substring(0, 120) + '...</div>' : ''}
  </div>
</div>`));
});

// ── Gateway Endpoints ───────────────────────────────

// BOOKINGS (via gateway)
app.get('/bookings', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var type = req.query.type || 'all';
  var page = parseInt(req.query.page) || 1;

  var typeMap = { flight: 'Flight', hotel: 'Hotel', bus: 'Bus', rental_car: 'RentalCar' };
  var body = {
    page: page,
    perPage: 10
  };

  // Filtro por tipo
  if (type !== 'all') {
    body.filters = { bookingTypes: [typeMap[type]] };
  }

  var result = await gatewayCall('POST', '/bff/booking/list', body);

  var tableHtml = '';
  if (!result.error && result.data && result.data.data && result.data.data.length > 0) {
    var rows = result.data.data.map(function (b) {
      var typeLabel = b.type || '?';
      var typeEmoji = { flight: 'Aereo', hotel: 'Hotel', bus: 'Onibus', rental_car: 'Carro' };
      var statusColors = { approved: 'badge-ok', pending: 'badge-warn', cancelled: 'badge-err', rejected: 'badge-err' };

      var route = '-';
      if (b.origin && b.destination) {
        route = (b.origin.iata || b.origin.city || b.origin) + ' &rarr; ' + (b.destination.iata || b.destination.city || b.destination);
      } else if (b.segments && b.segments.length > 0) {
        var s = b.segments[0];
        route = (s.origin || '') + ' &rarr; ' + (s.destination || '');
      } else if (b.hotel_name || b.name) {
        route = b.hotel_name || b.name;
      }

      return '<tr>'
        + '<td>' + (b.id || '-') + '</td>'
        + '<td><span class="badge badge-gw">' + (typeEmoji[typeLabel] || typeLabel) + '</span></td>'
        + '<td>' + route + '</td>'
        + '<td><span class="badge ' + (statusColors[b.status] || 'badge-warn') + '">' + (b.status_label || b.status || '-') + '</span></td>'
        + '<td>' + (b.departure_date || b.check_in || b.created_at || '-') + '</td>'
        + '<td style="font-weight:600;">R$ ' + (b.total_price || b.amount || b.price || '0.00') + '</td>'
        + '</tr>';
    }).join('');

    tableHtml = '<table><thead><tr><th>ID</th><th>Tipo</th><th>Rota/Local</th><th>Status</th><th>Data</th><th>Valor</th></tr></thead><tbody>' + rows + '</tbody></table>';

    // Paginacao
    var meta = result.data.meta || result.data;
    var totalPages = meta.last_page || meta.total_pages || 1;
    tableHtml += '<div style="margin-top:16px;display:flex;gap:8px;align-items:center;">';
    if (page > 1) tableHtml += '<a href="/bookings?type=' + type + '&page=' + (page - 1) + '" class="btn btn-sm">Anterior</a>';
    tableHtml += '<span class="stat"><b>Pagina:</b> ' + page + '/' + totalPages + '</span>';
    if (page < totalPages) tableHtml += '<a href="/bookings?type=' + type + '&page=' + (page + 1) + '" class="btn btn-sm">Proxima</a>';
    tableHtml += '</div>';
  } else if (result.error) {
    tableHtml = '<div class="empty" style="color:var(--error)">Erro: ' + JSON.stringify(result.data, null, 2) + '</div>';
  } else {
    tableHtml = '<div class="empty">Nenhuma reserva encontrada.</div>';
  }

  var filterHtml = `
    <div class="tab-bar">
      <a href="/bookings?type=all" class="tab ${type === 'all' ? 'active' : ''}">Todas</a>
      <a href="/bookings?type=flight" class="tab ${type === 'flight' ? 'active' : ''}">Aereo</a>
      <a href="/bookings?type=hotel" class="tab ${type === 'hotel' ? 'active' : ''}">Hotel</a>
      <a href="/bookings?type=bus" class="tab ${type === 'bus' ? 'active' : ''}">Onibus</a>
      <a href="/bookings?type=rental_car" class="tab ${type === 'rental_car' ? 'active' : ''}">Carro</a>
    </div>`;

  res.send(layout('Reservas', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Reservas (Bookings)</h1>
    <p class="sub">POST ${CONFIG.gatewayUrl}/bff/booking/list <span class="badge badge-gw">GATEWAY</span></p>
    ${filterHtml}
    ${tableHtml}
  </div>
  <div class="card">
    <h2>Response completo</h2>
    <div class="json-box">${JSON.stringify(result.data, null, 2)}</div>
  </div>
</div>`));
});

// FLIGHT SEARCH (formulário)
app.get('/flight-search', function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  // Data padrão: amanhã
  var tomorrow = new Date(Date.now() + 86400000);
  var defaultDate = tomorrow.toISOString().split('T')[0];

  res.send(layout('Buscar Voos', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Buscar Voos</h1>
    <p class="sub">POST ${CONFIG.gatewayUrl}/bff/quote/create <span class="badge badge-gw">GATEWAY</span></p>

    <form method="POST" action="/flight-search">
      <div class="form-row">
        <div class="form-group">
          <label>Origem (IATA)</label>
          <input type="text" name="origin" placeholder="CNF" value="CNF" maxlength="3" required>
        </div>
        <div class="form-group">
          <label>Destino (IATA)</label>
          <input type="text" name="destination" placeholder="GRU" value="GRU" maxlength="3" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Data Ida</label>
          <input type="date" name="departure_date" value="${defaultDate}" required>
        </div>
        <div class="form-group">
          <label>Data Volta (opcional)</label>
          <input type="date" name="return_date" value="">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Adultos</label>
          <input type="number" name="adults" value="1" min="1" max="9">
        </div>
        <div class="form-group">
          <label>Classe</label>
          <select name="cabin_class">
            <option value="economy" selected>Economica</option>
            <option value="business">Executiva</option>
            <option value="first">Primeira</option>
          </select>
        </div>
      </div>
      <button type="submit" class="btn btn-gw" style="margin-top:8px;">Buscar Voos</button>
    </form>
  </div>
</div>`));
});

// FLIGHT SEARCH (resultado)
app.post('/flight-search', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var origin = (req.body.origin || 'CNF').toUpperCase();
  var destination = (req.body.destination || 'GRU').toUpperCase();
  var departureDate = req.body.departure_date;
  var returnDate = req.body.return_date;
  var adults = parseInt(req.body.adults) || 1;
  var cabinClass = req.body.cabin_class || 'economy';

  var searchBody = {
    type: 'flight',
    trips: [
      {
        origin: origin,
        destination: destination,
        departure_date: departureDate
      }
    ],
    passengers: {
      adults: adults
    },
    cabin_class: cabinClass
  };

  // Se tem data de volta, adiciona segundo trecho
  if (returnDate) {
    searchBody.trips.push({
      origin: destination,
      destination: origin,
      departure_date: returnDate
    });
  }

  var result = await gatewayCall('POST', '/bff/quote/create', searchBody);

  var flightsHtml = '';
  if (!result.error && result.data) {
    var quotes = result.data.data || result.data.quotes || result.data;
    if (Array.isArray(quotes) && quotes.length > 0) {
      flightsHtml = quotes.map(function (q) {
        var segments = q.segments || q.trips || [];
        var segHtml = '';
        if (Array.isArray(segments)) {
          segHtml = segments.map(function (s) {
            return '<div class="flight-detail">'
              + (s.origin || s.departure_airport || '') + ' &rarr; ' + (s.destination || s.arrival_airport || '')
              + ' | ' + (s.departure_time || s.departure || '') + ' - ' + (s.arrival_time || s.arrival || '')
              + (s.airline ? ' | ' + s.airline : '')
              + (s.flight_number ? ' ' + s.flight_number : '')
              + (s.duration ? ' | ' + s.duration : '')
              + '</div>';
          }).join('');
        }

        var price = q.total_price || q.price || q.fare || q.amount || '?';
        var airline = q.airline || q.carrier || q.marketing_airline || '';

        return '<div class="flight-card">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;">'
          + '<div>'
          + '<div class="flight-route">' + origin + ' &rarr; ' + destination + (returnDate ? ' (ida e volta)' : ' (somente ida)') + '</div>'
          + (airline ? '<div class="flight-detail">' + airline + '</div>' : '')
          + segHtml
          + '</div>'
          + '<div class="flight-price">R$ ' + price + '</div>'
          + '</div></div>';
      }).join('');
    } else if (typeof quotes === 'object') {
      // Resposta pode ser um objeto com ID da cotacao (assíncrono)
      flightsHtml = '<div class="empty">Cotacao criada. A busca pode ser assincrona.</div>';
    }
  } else if (result.error) {
    flightsHtml = '<div class="empty" style="color:var(--error)">Erro: ' + JSON.stringify(result.data, null, 2) + '</div>';
  } else {
    flightsHtml = '<div class="empty">Nenhum voo encontrado para esta rota.</div>';
  }

  res.send(layout('Resultados', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/flight-search" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Nova busca</a>
    <h1>Resultados: ${origin} &rarr; ${destination}</h1>
    <p class="sub">${departureDate}${returnDate ? ' | Volta: ' + returnDate : ''} | ${adults} adulto(s) | ${cabinClass}</p>
    <div style="margin-bottom:16px;">
      <span class="stat"><b>Rota:</b> ${origin} &rarr; ${destination}</span>
      <span class="stat"><b>Classe:</b> ${cabinClass}</span>
    </div>
    ${flightsHtml}
  </div>
  <div class="card">
    <h2>Request enviado</h2>
    <div class="json-box">${JSON.stringify(searchBody, null, 2)}</div>
  </div>
  <div class="card">
    <h2>Response completo</h2>
    <div class="json-box">${JSON.stringify(result.data, null, 2)}</div>
  </div>
</div>`));
});

// GATEWAY TOKEN INFO
app.get('/gateway-token', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var gwPayload = tokenStore.gateway_token ? decodeJwt(tokenStore.gateway_token) : null;
  var gwExpired = isGatewayTokenExpired();

  res.send(layout('Gateway Token', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Gateway Token</h1>
    <p class="sub">GET ${CONFIG.apiUrl}/v1/auth/token/internal &rarr; Token EdDSA para ${CONFIG.gatewayUrl}</p>
    <span class="badge ${!tokenStore.gateway_token ? 'badge-err' : gwExpired ? 'badge-warn' : 'badge-gw'}">
      ${!tokenStore.gateway_token ? 'NAO OBTIDO' : gwExpired ? 'EXPIRADO' : 'ATIVO'}
    </span>
    ${!tokenStore.gateway_token ? '<br><br><a href="/refresh-gateway" class="btn btn-gw">Obter Gateway Token</a>' : ''}
  </div>
  ${tokenStore.gateway_token ? `
  <div class="card">
    <h2>Gateway Access Token (EdDSA)</h2>
    <div class="token-box">${tokenStore.gateway_token}</div>
  </div>
  ${tokenStore.gateway_refresh_token ? `
  <div class="card">
    <h2>Gateway Refresh Token</h2>
    <div class="token-box">${tokenStore.gateway_refresh_token}</div>
  </div>` : ''}
  <div class="card">
    <h2>Token Payload (decoded)</h2>
    <div class="json-box">${JSON.stringify(gwPayload, null, 2)}</div>
  </div>` : ''}
</div>`));
});

// REFRESH GATEWAY TOKEN
app.get('/refresh-gateway', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var result = await fetchGatewayToken();
  var gwPayload = tokenStore.gateway_token ? decodeJwt(tokenStore.gateway_token) : null;

  res.send(layout('Refresh Gateway', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>${result.error ? 'Falha ao obter Gateway Token' : 'Gateway Token renovado!'}</h1>
    <span class="badge ${result.error ? 'badge-err' : 'badge-gw'}">${result.error ? 'FALHOU' : 'SUCESSO'}</span>
    ${result.error ? '<div class="json-box" style="margin-top:12px;">' + JSON.stringify(result, null, 2) + '</div>' : ''}
    ${!result.error ? '<div class="token-box" style="margin-top:12px;">' + tokenStore.gateway_token.substring(0, 120) + '...</div>' : ''}
    ${!result.error && gwPayload ? '<div class="json-box" style="margin-top:12px;">' + JSON.stringify(gwPayload, null, 2) + '</div>' : ''}
  </div>
</div>`));
});

// ── API Direta Endpoints ────────────────────────────

// TRAVELS
app.get('/travels', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var page = parseInt(req.query.page) || 1;
  var perPage = parseInt(req.query.perPage) || 10;
  var result = await apiCall('GET', '/travel/order/fly-order', {
    include: 'travellers,refundOrders,nextApprovalUsers,approvalFlowHistory.changedBy',
    page: page,
    perPage: perPage,
    sortOrder: 'DESC',
    sortBy: 'id'
  });

  var tableHtml = '';
  if (!result.error && result.data && result.data.data && result.data.data.length > 0) {
    var rows = result.data.data.map(function (o) {
      return '<tr>'
        + '<td>' + (o.id || '-') + '</td>'
        + '<td>' + (o.locator || o.booking_code || '-') + '</td>'
        + '<td>' + (o.status_label || o.status || '-') + '</td>'
        + '<td>' + (o.origin || '-') + ' &rarr; ' + (o.destination || '-') + '</td>'
        + '<td>' + (o.departure_date || o.created_at || '-') + '</td>'
        + '<td>R$ ' + (o.total_price || o.amount || '0.00') + '</td>'
        + '</tr>';
    }).join('');
    tableHtml = '<table><thead><tr><th>ID</th><th>Localizador</th><th>Status</th><th>Trecho</th><th>Data</th><th>Valor</th></tr></thead><tbody>' + rows + '</tbody></table>';

    var meta = result.data.meta || {};
    var totalPages = meta.last_page || meta.total_pages || 1;
    tableHtml += '<div style="margin-top:16px;display:flex;gap:8px;align-items:center;">';
    if (page > 1) tableHtml += '<a href="/travels?page=' + (page - 1) + '" class="btn btn-sm">Anterior</a>';
    tableHtml += '<span class="stat"><b>Pagina:</b> ' + page + '/' + totalPages + '</span>';
    if (page < totalPages) tableHtml += '<a href="/travels?page=' + (page + 1) + '" class="btn btn-sm">Proxima</a>';
    tableHtml += '</div>';
  } else if (result.error) {
    tableHtml = '<div class="empty" style="color:var(--error)">Erro: ' + JSON.stringify(result.data) + '</div>';
  } else {
    tableHtml = '<div class="empty">Nenhuma viagem aerea encontrada.</div>';
  }

  res.send(layout('Viagens', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Viagens Aereas</h1>
    <p class="sub">GET /travel/order/fly-order <span class="badge badge-ok">API</span></p>
    ${tableHtml}
  </div>
  <div class="card">
    <h2>Response completo</h2>
    <div class="json-box">${JSON.stringify(result.data, null, 2)}</div>
  </div>
</div>`));
});

// HOTEL ORDERS
app.get('/hotel-orders', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var page = parseInt(req.query.page) || 1;
  var result = await apiCall('GET', '/travel/order/hotel-order', {
    include: 'guests',
    page: page,
    perPage: 10,
    sortOrder: 'DESC',
    sortBy: 'id'
  });

  var tableHtml = '';
  if (!result.error && result.data && result.data.data && result.data.data.length > 0) {
    var rows = result.data.data.map(function (o) {
      return '<tr>'
        + '<td>' + (o.id || '-') + '</td>'
        + '<td>' + (o.hotel_name || o.name || '-') + '</td>'
        + '<td>' + (o.status_label || o.status || '-') + '</td>'
        + '<td>' + (o.check_in || '-') + '</td>'
        + '<td>' + (o.check_out || '-') + '</td>'
        + '<td>R$ ' + (o.total_price || o.amount || '0.00') + '</td>'
        + '</tr>';
    }).join('');
    tableHtml = '<table><thead><tr><th>ID</th><th>Hotel</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Valor</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } else if (result.error) {
    tableHtml = '<div class="empty" style="color:var(--error)">Erro: ' + JSON.stringify(result.data) + '</div>';
  } else {
    tableHtml = '<div class="empty">Nenhuma hospedagem encontrada.</div>';
  }

  res.send(layout('Hospedagens', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Hospedagens</h1>
    <p class="sub">GET /travel/order/hotel-order <span class="badge badge-ok">API</span></p>
    ${tableHtml}
  </div>
  <div class="card">
    <h2>Response completo</h2>
    <div class="json-box">${JSON.stringify(result.data, null, 2)}</div>
  </div>
</div>`));
});

// USER INFO
app.get('/user-info', async function (req, res) {
  if (!tokenStore.access_token) return res.redirect('/');

  var payload = decodeJwt(tokenStore.access_token);
  var userId = payload ? payload.sub : null;
  var result = userId ? await apiCall('GET', '/employees/' + userId, { userId: userId, paginate: false, include: 'permissions' }) : { error: true, data: { message: 'userId nao encontrado no token' } };

  res.send(layout('Usuario', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>Dados do Usuario</h1>
    <p class="sub">GET /employees/${userId} <span class="badge badge-ok">API</span></p>
    <span class="badge ${result.error ? 'badge-err' : 'badge-ok'}">${result.error ? 'ERRO' : 'OK'}</span>
  </div>
  <div class="card">
    <h2>Response</h2>
    <div class="json-box">${JSON.stringify(result.data, null, 2)}</div>
  </div>
</div>`));
});

// REFRESH TOKEN
app.get('/refresh', async function (req, res) {
  if (!tokenStore.refresh_token) {
    return res.send(layout('Refresh', `<div class="page"><div class="card" style="max-width:480px;">
      ${logoHtml()}<h1 style="color:var(--error)">Sem refresh token</h1>
      <p class="sub">O token atual nao possui refresh_token.</p>
      <a href="/dashboard" class="back">Voltar</a></div></div>`));
  }

  var success = await refreshAccessToken();

  res.send(layout('Refresh', `
<div class="page-scroll">
  <div class="card">
    ${logoHtml()}
    <a href="/dashboard" class="back" style="margin-bottom:16px;display:inline-flex;">&larr; Dashboard</a>
    <h1>${success ? 'Token renovado!' : 'Falha no refresh'}</h1>
    <span class="badge ${success ? 'badge-ok' : 'badge-err'}">${success ? 'SUCESSO' : 'FALHOU'}</span>
    ${success ? '<div class="token-box" style="margin-top:12px;">' + tokenStore.access_token.substring(0, 120) + '...</div>' : '<p class="sub">Nao foi possivel renovar. Reconecte.</p>'}
    ${success ? '<div style="margin-top:8px;"><span class="stat"><b>novo expires_at:</b> ' + new Date(tokenStore.expires_at).toLocaleString('pt-BR') + '</span></div>' : ''}
  </div>
</div>`));
});

// DISCONNECT
app.get('/disconnect', function (req, res) {
  tokenStore = { access_token: null, refresh_token: null, expires_at: null, user: null, gateway_token: null, gateway_refresh_token: null, gateway_expires_at: null };
  CONFIG.state = 'onfly_' + Math.random().toString(36).substring(2, 10);
  res.redirect('/');
});

// ── Start ───────────────────────────────────────────
var actualPort;

(async function () {
  actualPort = await findPort(CONFIG.preferredPort);
  app.listen(actualPort, function () {
    console.log('');
    console.log('  \x1b[36m\x1b[1m  Onfly OAuth Skill\x1b[0m');
    console.log('  \x1b[90m  ──────────────────────────\x1b[0m');
    console.log('');
    console.log('  \x1b[32m  http://localhost:' + actualPort + '\x1b[0m');
    console.log('');
    console.log('  \x1b[90m  client_id:    \x1b[0m' + CONFIG.clientId);
    console.log('  \x1b[90m  api:          \x1b[0m' + CONFIG.apiUrl);
    console.log('  \x1b[90m  gateway:      \x1b[0m' + CONFIG.gatewayUrl);
    console.log('  \x1b[90m  redirect_uri: \x1b[0mhttp://localhost:' + actualPort + '/callback');
    console.log('');
    if (CONFIG.preferredPort !== actualPort) {
      console.log('  \x1b[33m  Porta ' + CONFIG.preferredPort + ' estava em uso, usando ' + actualPort + '\x1b[0m');
      console.log('');
    }
  });
})();

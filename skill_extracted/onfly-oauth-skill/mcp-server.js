const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const express = require('express');
const axios = require('axios');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// ── Config ──────────────────────────────────────────
const TOKEN_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.onfly-tokens.json');

const CONFIG = {
  apiUrl: 'https://api.onfly.com',
  appUrl: 'https://app.onfly.com',
  gatewayUrl: 'https://toguro-app-prod.onfly.com',
  clientId: process.env.CLIENT_ID || '1212',
  clientSecret: process.env.CLIENT_SECRET || 'fLWgKiTE4qmkx7pXwfEcTB7yNjKiisygEbbinWEV',
  preferredPort: parseInt(process.env.PORT) || 3333,
  state: 'onfly_' + Math.random().toString(36).substring(2, 10)
};

// ── Token store ─────────────────────────────────────
var tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null,
  user: null,
  gateway_token: null,
  gateway_refresh_token: null,
  gateway_expires_at: null
};

// Persist tokens to disk
function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

// Load tokens from disk
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      var data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      Object.assign(tokenStore, data);
    }
  } catch (e) { /* ignore */ }
}

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
    saveTokens();
    return true;
  } catch (e) {
    return false;
  }
}

async function fetchGatewayToken() {
  if (isTokenExpired()) {
    var refreshed = await refreshAccessToken();
    if (!refreshed) return { error: true, message: 'Passport token expirado e refresh falhou.' };
  }
  try {
    var resp = await axios.get(CONFIG.apiUrl + '/auth/token/internal', {
      headers: {
        'Authorization': 'Bearer ' + tokenStore.access_token,
        'Accept': 'application/prs.onfly.v1+json'
      }
    });
    tokenStore.gateway_token = resp.data.token;
    tokenStore.gateway_refresh_token = resp.data.refreshToken || null;
    tokenStore.gateway_expires_at = Date.now() + (15 * 60 * 1000);
    saveTokens();
    return { error: false };
  } catch (e) {
    var errData = e.response ? e.response.data : { message: e.message };
    return { error: true, message: 'Falha ao obter gateway token', data: errData };
  }
}

async function refreshGatewayToken() {
  if (!tokenStore.gateway_refresh_token) return { error: true, message: 'Sem refresh token do gateway.' };
  try {
    var resp = await axios.post(CONFIG.gatewayUrl + '/bff/auth/refresh', {
      refreshToken: tokenStore.gateway_refresh_token
    }, {
      headers: {
        'Authorization': 'Bearer ' + tokenStore.gateway_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    tokenStore.gateway_token = resp.data.token;
    if (resp.data.refreshToken) tokenStore.gateway_refresh_token = resp.data.refreshToken;
    tokenStore.gateway_expires_at = Date.now() + (15 * 60 * 1000);
    saveTokens();
    return { error: false };
  } catch (e) {
    return { error: true, message: 'Gateway refresh falhou', data: e.response ? e.response.data : { message: e.message } };
  }
}

async function ensureGatewayToken() {
  if (!tokenStore.gateway_token || isGatewayTokenExpired()) {
    // Tenta refresh primeiro se tiver refresh token
    if (tokenStore.gateway_refresh_token) {
      var refreshResult = await refreshGatewayToken();
      if (!refreshResult.error) return refreshResult;
    }
    // Fallback: busca novo token via API
    return await fetchGatewayToken();
  }
  return { error: false };
}

async function fetchLoggedTraveler() {
  var gwResult = await ensureGatewayToken();
  if (gwResult.error) return null;
  var result = await gatewayCall('GET', '/bff/get-logged-traveler');
  if (result.error || !result.data) return null;
  var t = result.data;
  tokenStore.traveler = {
    id: t.id || '',
    birthday: t.birthday || '',
    firstName: t.firstName || '',
    lastName: t.lastName || '',
    email: t.email || ''
  };
  saveTokens();
  return tokenStore.traveler;
}

async function apiCall(method, path, params) {
  if (isTokenExpired()) {
    var refreshed = await refreshAccessToken();
    if (!refreshed) return { error: true, data: { message: 'Token expirado e refresh falhou. Reconecte com onfly_connect.' } };
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
    if (e.response && (e.response.status === 401 || (e.response.data && e.response.data.code === 'invalid_token_provided'))) {
      // Tenta refresh primeiro, fallback para novo token
      var retryResult = tokenStore.gateway_refresh_token ? await refreshGatewayToken() : { error: true };
      if (retryResult.error) retryResult = await fetchGatewayToken();
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

// ── Express OAuth Server (internal) ─────────────────
var expressApp = express();
expressApp.use(express.urlencoded({ extended: true }));
var actualPort = null;
var expressServer = null;

// Track pending auth callbacks
var authResolve = null;

// Shared page styles
var PAGE_STYLES = [
  '* { margin: 0; padding: 0; box-sizing: border-box; }',
  'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #F5F0E8; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }',
  '.container { width: 100%; max-width: 520px; }',
  '.card { background: #fff; border-radius: 16px; padding: 40px 36px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 30px rgba(0,0,0,0.06); }',
  '.logos-container { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 28px; }',
  '.logo-box { width: 56px; height: 56px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }',
  '.logo-box.claude { background: #1a1a1a; }',
  '.logo-box.onfly { background: #1E3A5F; }',
  '.logo-box svg, .logo-box img { width: 36px; height: 36px; }',
  '.logo-connector { width: 32px; height: 2px; background: #D4C9B8; border-radius: 1px; }',
  '.title { font-size: 20px; font-weight: 600; color: #1a1a1a; text-align: center; margin-bottom: 20px; }',
  '.description { font-size: 14px; color: #4a4a4a; line-height: 1.6; margin-bottom: 8px; }',
  '.description strong { color: #1a1a1a; }',
  '.permissions-list { list-style: none; padding: 0; margin: 0 0 16px 0; }',
  '.permissions-list li { font-size: 14px; color: #4a4a4a; line-height: 1.6; padding: 3px 0 3px 20px; position: relative; }',
  '.permissions-list li::before { content: "\\2022"; position: absolute; left: 6px; color: #9a8c7a; }',
  '.note { font-size: 13px; color: #7a7a7a; margin-top: 12px; }',
  '.note a { color: #1a1a1a; text-decoration: underline; }',
  '.status-icon { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 24px; }',
  '.status-icon.success { background: #dcfce7; }',
  '.status-icon.error { background: #fee2e2; }',
  '.user-info { background: #f8f6f2; border-radius: 10px; padding: 16px; margin-top: 16px; }',
  '.user-info p { font-size: 13px; color: #4a4a4a; line-height: 1.8; }',
  '.user-info span { font-weight: 600; color: #1a1a1a; }',
  '.error-detail { background: #fef2f2; border-radius: 10px; padding: 16px; margin-top: 16px; font-size: 12px; color: #7a3a3a; overflow: auto; max-height: 200px; white-space: pre-wrap; font-family: "SF Mono", Monaco, monospace; }'
].join('\n');

var CLAUDE_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="none"><path d="M12.06 37.12L22.14 30.79l.15-.52-.19-.27-.51.03-1.74-.02-5.93.13-5.14.04-5-.02-1.26-.2-1.25-1.5.08-.77 1.02-.77 1.51.06 3.34.07 5.03.1 3.63.03 5.41.29.85-.04.1-.35-.3-.2-.24-.2-5.35-3.26-5.79-3.42-3.04-2-1.62-.99-.85-.97-.45-2.2 1.35-1.65 1.94.04.49.11 2.04 1.41 4.35 3.04 5.66 3.75.83.62.31-.23.04-.16-.4-.59-3.23-5.22-3.43-5.31-1.54-2.2-.43-1.33c-.17-.56-.28-1.02-.31-1.6l1.51-2.3.9-.33 2.21.18.95.75 1.52 3.05 2.43 4.78 3.75 6.49 1.09 1.93.63 1.8.23.54.34-.02-.02-.32.1-3.76.29-4.62.22-5.94.09-1.67.73-2.05 1.6-1.16 1.31.54 1.13 1.45-.09.99-.43 4.1-.91 6.42-.59 4.32.46-.02.51-.58 2.02-2.96 3.39-4.72 1.51-1.88 1.78-2.07 1.15-1.01 2.28-.11 1.77 2.4-.61 2.6-2.19 3.07-1.81 2.61-2.6 3.85-1.57 3.08.17.24.41-.06 6.2-1.66 3.36-.77 4.01-.89 1.86.76.24.86-.62 1.81-4.28 1.27-5.02 1.28-7.46 2.15-.08.07.11.14 3.42.14 1.46.01 3.56-.18 6.66.18 1.79 1.05 1.09 1.35-.12 1.09-2.61 1.48-3.63-.67-8.5-2.26-2.91-.57-.4.02.01.24 2.51 2.23 4.61 3.75 5.75 4.85.35 1.25-.66 1.04-.75-.07-4.95-3.41-1.96-1.54-4.39-3.36-.29.01.02.37 1.04 1.38 5.53 7.49.38 2.36-.33.79-1.32.54-1.47-.19-3.25-4.1-3.34-4.6-2.72-4.16-.29.21-.71 16L29.13 53.35l-1.57.69-1.39-.94-.79-1.6.55-3.28.65-4.27.52-3.39.42-4.2.31-1.41-.04-.09-.3.07-2.93 4.47-4.47 6.71-3.59 4.23-.89.41-1.61-.74.07-1.46.82-1.34 4.91-6.91 2.96-4.3 1.92-2.48-.04-.34-.11-.01-13.47 9.76-2.46.44-1.13-.95.06-1.65.49-.55 4.04-3.09Z" fill="#FAF9F5"/></svg>';

var ONFLY_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" fill="#fff" opacity="0.9"/><text x="20" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="16" fill="#1E3A5F">O</text></svg>';

function buildPage(title, bodyContent) {
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>' + PAGE_STYLES + '</style></head><body>' + bodyContent + '</body></html>';
}

function logosHtml() {
  return '<div class="logos-container">'
    + '<div class="logo-box claude">' + CLAUDE_LOGO_SVG + '</div>'
    + '<div class="logo-connector"></div>'
    + '<div class="logo-box onfly">' + ONFLY_LOGO_SVG + '</div>'
    + '</div>';
}

expressApp.get('/', function (req, res) {
  var body = '<div class="container"><div class="card">'
    + logosHtml()
    + '<h1 class="title">Conectar Claude Code a Onfly</h1>'
    + '<div class="disclaimer-section">'
    + '<p class="description"><strong>Ao autorizar, o Claude Code podera:</strong></p>'
    + '<ul class="permissions-list">'
    + '<li>Buscar voos, hoteis, onibus e carros pela Onfly</li>'
    + '<li>Listar e ver detalhes das suas reservas</li>'
    + '<li>Aprovar ou reprovar reservas pendentes</li>'
    + '<li>Consultar o dashboard de viagens corporativas</li>'
    + '</ul>'
    + '<p class="description"><strong>Voce mantem o controle dos seus dados:</strong></p>'
    + '<ul class="permissions-list">'
    + '<li>Seus dados nao sao compartilhados com terceiros</li>'
    + '<li>Voce pode desconectar a qualquer momento com <code>onfly_disconnect</code></li>'
    + '</ul>'
    + '<p class="description note">Use <code>onfly_connect</code> no Claude Code para iniciar a autenticacao.</p>'
    + '</div></div></div>';
  res.send(buildPage('Onfly OAuth - Claude Code', body));
});

expressApp.get('/callback', async function (req, res) {
  var code = req.query.code;
  var state = req.query.state;
  var error = req.query.error;

  if (error) {
    var errBody = '<div class="container"><div class="card">'
      + logosHtml()
      + '<div class="status-icon error">&#10005;</div>'
      + '<h1 class="title">Acesso negado</h1>'
      + '<p class="description" style="text-align:center;">' + (req.query.error_description || 'O usuario nao autorizou o acesso.') + '</p>'
      + '<p class="description note" style="text-align:center;">Tente novamente com <code>onfly_connect</code> no Claude Code.</p>'
      + '</div></div>';
    res.send(buildPage('Onfly - Acesso Negado', errBody));
    if (authResolve) { authResolve({ error: true, message: 'Acesso negado pelo usuario' }); authResolve = null; }
    return;
  }

  if (state !== CONFIG.state) {
    var csrfBody = '<div class="container"><div class="card">'
      + logosHtml()
      + '<div class="status-icon error">&#10005;</div>'
      + '<h1 class="title">Erro de seguranca</h1>'
      + '<p class="description" style="text-align:center;">State mismatch — possivel tentativa de CSRF.</p>'
      + '</div></div>';
    res.send(buildPage('Onfly - Erro', csrfBody));
    if (authResolve) { authResolve({ error: true, message: 'State mismatch' }); authResolve = null; }
    return;
  }

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

    var payload = decodeJwt(tokenStore.access_token);
    if (payload && payload.sub) {
      var userResp = await apiCall('GET', '/employees/' + payload.sub, { userId: payload.sub, paginate: false, include: 'permissions' });
      if (!userResp.error) {
        var ud = userResp.data.data || userResp.data;
        tokenStore.user = {
          id: ud.id || payload.sub,
          name: ud.first_name || ud.name || '',
          email: ud.email || '',
          birthday: ud.birthday || ud.birth_date || '',
          company: (ud.company && ud.company.social_name) || ''
        };
      }
    }

    await fetchGatewayToken();
    await fetchLoggedTraveler();
    saveTokens();

    var user = tokenStore.user || {};
    var successBody = '<div class="container"><div class="card">'
      + logosHtml()
      + '<div class="status-icon success">&#10003;</div>'
      + '<h1 class="title">Conectado com sucesso!</h1>'
      + '<p class="description" style="text-align:center;">Voce ja pode fechar esta janela e voltar ao Claude Code.</p>'
      + (user.name ? '<div class="user-info">'
        + '<p><span>Usuario:</span> ' + user.name + '</p>'
        + '<p><span>Email:</span> ' + (user.email || '-') + '</p>'
        + '<p><span>Empresa:</span> ' + (user.company || '-') + '</p>'
        + '</div>' : '')
      + '</div></div>';
    res.send(buildPage('Onfly - Conectado', successBody));

    if (authResolve) { authResolve({ error: false }); authResolve = null; }
  } catch (e) {
    var errData = e.response ? e.response.data : { message: e.message };
    var exchBody = '<div class="container"><div class="card">'
      + logosHtml()
      + '<div class="status-icon error">&#10005;</div>'
      + '<h1 class="title">Erro na autenticacao</h1>'
      + '<p class="description" style="text-align:center;">Falha ao trocar o codigo de autorizacao por um token.</p>'
      + '<div class="error-detail">' + JSON.stringify(errData, null, 2) + '</div>'
      + '</div></div>';
    res.send(buildPage('Onfly - Erro', exchBody));
    if (authResolve) { authResolve({ error: true, message: 'Token exchange falhou', data: errData }); authResolve = null; }
  }
});

async function ensureExpressRunning() {
  if (expressServer && actualPort) return actualPort;
  actualPort = await findPort(CONFIG.preferredPort);
  return new Promise(function (resolve) {
    expressServer = expressApp.listen(actualPort, function () {
      resolve(actualPort);
    });
  });
}

// ── MCP Server ──────────────────────────────────────
const server = new McpServer({
  name: 'onfly',
  version: '1.0.0'
});

// Tool: onfly_auth_status
server.tool(
  'onfly_auth_status',
  'Verifica se esta autenticado na Onfly e mostra info do usuario',
  {},
  async function () {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect para iniciar o login OAuth.' }] };
    }

    var expired = isTokenExpired();
    if (expired) {
      var refreshed = await refreshAccessToken();
      if (!refreshed) {
        return { content: [{ type: 'text', text: 'Token expirado e refresh falhou. Use onfly_connect para reconectar.' }] };
      }
    }

    var user = tokenStore.user || {};
    var expiresIn = tokenStore.expires_at ? Math.max(0, Math.floor((tokenStore.expires_at - Date.now()) / 60000)) : '?';
    var gwStatus = tokenStore.gateway_token ? (isGatewayTokenExpired() ? 'expirado' : 'ativo') : 'nao obtido';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          autenticado: true,
          usuario: user.name || 'desconhecido',
          email: user.email || 'desconhecido',
          empresa: user.company || 'desconhecida',
          api_token: 'ativo (expira em ' + expiresIn + ' min)',
          gateway_token: gwStatus,
          viajante: tokenStore.traveler ? { id: tokenStore.traveler.id, nome: tokenStore.traveler.firstName + ' ' + tokenStore.traveler.lastName, birthday: tokenStore.traveler.birthday } : 'nao obtido'
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_connect
server.tool(
  'onfly_connect',
  'Inicia autenticacao OAuth na Onfly. Retorna URL para abrir no browser.',
  {},
  async function () {
    var port = await ensureExpressRunning();
    CONFIG.state = 'onfly_' + Math.random().toString(36).substring(2, 10);

    var redirectUri = 'http://localhost:' + port + '/callback';
    var authorizeUrl = CONFIG.appUrl + '/v2#/auth/oauth/authorize'
      + '?client_id=' + encodeURIComponent(CONFIG.clientId)
      + '&redirect_uri=' + encodeURIComponent(redirectUri)
      + '&response_type=code'
      + '&state=' + encodeURIComponent(CONFIG.state);

    // Open browser automatically
    var openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(openCmd + ' "' + authorizeUrl + '"');

    // Wait for callback (up to 120 seconds)
    var result = await new Promise(function (resolve) {
      authResolve = resolve;
      setTimeout(function () {
        if (authResolve) {
          authResolve({ error: true, message: 'Timeout: usuario nao completou a autenticacao em 120s' });
          authResolve = null;
        }
      }, 120000);
    });

    if (result.error) {
      return { content: [{ type: 'text', text: 'Falha na autenticacao: ' + result.message }] };
    }

    var user = tokenStore.user || {};
    return {
      content: [{
        type: 'text',
        text: 'Autenticado com sucesso!\n\nUsuario: ' + (user.name || '?') + '\nEmail: ' + (user.email || '?') + '\nEmpresa: ' + (user.company || '?')
      }]
    };
  }
);

// Tool: onfly_list_travels
server.tool(
  'onfly_list_travels',
  'Lista viagens aereas da Onfly (GET /travel/order/fly-order)',
  {
    page: z.number().optional().default(1).describe('Numero da pagina'),
    perPage: z.number().optional().default(10).describe('Itens por pagina')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await apiCall('GET', '/travel/order/fly-order', {
      include: 'travellers,refundOrders,nextApprovalUsers,approvalFlowHistory.changedBy',
      page: params.page,
      perPage: params.perPage,
      sortOrder: 'DESC',
      sortBy: 'id'
    });

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao listar viagens: ' + JSON.stringify(result.data) }] };
    }

    var travels = (result.data.data || []).map(function (o) {
      return {
        id: o.id,
        bookingId: o.bookingId || null,
        protocolo: o.protocol || o.locator || '-',
        status: o.labelStatus || o.status,
        trecho: (o.origin || '?') + ' -> ' + (o.destination || '?'),
        data: o.departureDate || o.departure_date || o.createdAt || '-',
        passageiro: o.consumer || '-',
        valor: 'R$ ' + ((o.amount || 0) / 100).toFixed(2)
      };
    });

    var pagination = (result.data.meta && result.data.meta.pagination) || {};
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: pagination.total || travels.length,
          pagina: params.page + '/' + (pagination.total_pages || 1),
          viagens: travels
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_list_hotel_orders
server.tool(
  'onfly_list_hotel_orders',
  'Lista hospedagens da Onfly (GET /travel/order/hotel-order)',
  {
    page: z.number().optional().default(1).describe('Numero da pagina'),
    perPage: z.number().optional().default(10).describe('Itens por pagina')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await apiCall('GET', '/travel/order/hotel-order', {
      include: 'guests',
      page: params.page,
      perPage: params.perPage,
      sortOrder: 'DESC',
      sortBy: 'id'
    });

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao listar hospedagens: ' + JSON.stringify(result.data) }] };
    }

    var hotels = (result.data.data || []).map(function (o) {
      return {
        id: o.id,
        bookingId: o.bookingId || null,
        protocolo: o.protocol || '-',
        hotel: o.hotelName || '-',
        cidade: o.city || '-',
        status: o.labelStatus || o.status,
        checkin: o.checkin || '-',
        checkout: o.checkout || '-',
        quarto: o.roomDescription || '-',
        hospede: o.consumer || '-',
        valor: 'R$ ' + ((o.amount || 0) / 100).toFixed(2),
        reembolsavel: o.isRefundable ? 'Sim' : 'Nao'
      };
    });

    var pagination = (result.data.meta && result.data.meta.pagination) || {};
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: pagination.total || hotels.length,
          pagina: params.page + '/' + (pagination.total_pages || 1),
          hospedagens: hotels
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_list_bookings
server.tool(
  'onfly_list_bookings',
  'Lista reservas via gateway da Onfly (POST /bff/booking/list)',
  {
    page: z.number().optional().default(1).describe('Numero da pagina'),
    limit: z.number().optional().default(10).describe('Itens por pagina'),
    type: z.enum(['all', 'flight', 'hotel', 'bus', 'rental_car']).optional().default('all').describe('Tipo de reserva')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var typeMap = { flight: 'Flight', hotel: 'Hotel', bus: 'Bus', rental_car: 'RentalCar' };
    var body = {
      page: params.page,
      perPage: params.limit
    };
    if (params.type !== 'all') {
      body.filters = { bookingTypes: [typeMap[params.type]] };
    }

    var result = await gatewayCall('POST', '/bff/booking/list', body);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao listar reservas: ' + JSON.stringify(result.data) }] };
    }

    var bookings = (result.data.data || []).map(function (b) {
      var route = '-';
      if (b.origin && b.destination) {
        route = (b.origin.iata || b.origin.city || b.origin) + ' -> ' + (b.destination.iata || b.destination.city || b.destination);
      } else if (b.segments && b.segments.length > 0) {
        route = (b.segments[0].origin || '') + ' -> ' + (b.segments[0].destination || '');
      } else if (b.hotelName || b.hotel_name || b.name) {
        route = b.hotelName || b.hotel_name || b.name;
      }

      return {
        id: b.id,
        bookingId: b.bookingId || null,
        protocolo: b.protocol || '-',
        tipo: b.type || '?',
        rota: route,
        status: b.labelStatus || b.status_label || b.status,
        data: b.departureDate || b.departure_date || b.checkin || b.check_in || b.createdAt || b.created_at || '-',
        passageiro: b.consumer || '-',
        valor: 'R$ ' + ((b.amount || 0) / 100).toFixed(2)
      };
    });

    var pagination = (result.data.meta && result.data.meta.pagination) || result.data.meta || {};
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: pagination.total || bookings.length,
          pagina: params.page + '/' + (pagination.total_pages || 1),
          reservas: bookings
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_flights
server.tool(
  'onfly_search_flights',
  'Busca voos na Onfly (POST /bff/quote/create)',
  {
    origin: z.string().length(3).describe('Codigo IATA de origem (ex: CNF)'),
    destination: z.string().length(3).describe('Codigo IATA de destino (ex: GRU)'),
    departure_date: z.string().describe('Data de ida (YYYY-MM-DD)'),
    return_date: z.string().optional().describe('Data de volta (YYYY-MM-DD, opcional)')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var origin = params.origin.toUpperCase();
    var destination = params.destination.toUpperCase();

    // Busca dados do viajante logado
    var travelerData = tokenStore.traveler;
    if (!travelerData || !travelerData.id) {
      travelerData = await fetchLoggedTraveler();
    }
    if (!travelerData || !travelerData.id) {
      return { content: [{ type: 'text', text: 'Nao foi possivel obter dados do viajante. Verifique se seu perfil de viajante esta cadastrado na Onfly.' }] };
    }

    var flight = {
      departure: params.departure_date,
      from: origin,
      to: destination,
      travelers: [{
        travelerEntityId: String(travelerData.id),
        birthday: travelerData.birthday
      }]
    };

    if (params.return_date) {
      flight['return'] = params.return_date;
    }

    var searchBody = {
      owners: [null],
      flights: [flight],
      groupFlights: true
    };

    var result = await gatewayCall('POST', '/bff/quote/create', searchBody);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar voos: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          busca: origin + ' -> ' + destination,
          ida: params.departure_date,
          volta: params.return_date || 'somente ida',
          resultado: result.data
        }, null, 2)
      }]
    };
  }
);

// ── Auxiliares de destino ────────────────────────────

// Tool: onfly_search_airports
server.tool(
  'onfly_search_airports',
  'Busca aeroportos por nome ou codigo IATA (GET /bff/destination/airports)',
  {
    search: z.string().describe('Nome da cidade/aeroporto ou codigo IATA (ex: Confins, GRU)')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('GET', '/bff/destination/airports?search=' + encodeURIComponent(params.search));

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar aeroportos: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ busca: params.search, aeroportos: result.data.data || result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_cities
server.tool(
  'onfly_search_cities',
  'Busca cidades por nome para obter city_id (GET /bff/destination/cities/autocomplete)',
  {
    search: z.string().describe('Nome da cidade (ex: Sao Paulo)')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('GET', '/bff/destination/cities/autocomplete?search=' + encodeURIComponent(params.search));

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar cidades: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ busca: params.search, cidades: result.data.data || result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_bus_destinations
server.tool(
  'onfly_search_bus_destinations',
  'Busca destinos de onibus por nome (GET /bff/destination/bus-destinations)',
  {
    search: z.string().describe('Nome da cidade ou terminal')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('GET', '/bff/destination/bus-destinations?search=' + encodeURIComponent(params.search));

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar destinos de onibus: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ busca: params.search, destinos: result.data.data || result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_rental_car_agencies
server.tool(
  'onfly_search_rental_car_agencies',
  'Busca locadoras de veiculos por nome (GET /bff/destination/rental-car-agencies)',
  {
    search: z.string().describe('Nome da locadora ou cidade')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('GET', '/bff/destination/rental-car-agencies?search=' + encodeURIComponent(params.search));

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar locadoras: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ busca: params.search, locadoras: result.data.data || result.data }, null, 2)
      }]
    };
  }
);

// ── Buscas adicionais ───────────────────────────────

// Tool: onfly_search_hotels
server.tool(
  'onfly_search_hotels',
  'Busca hoteis na Onfly (POST /bff/quote/create)',
  {
    city_id: z.string().describe('ID da cidade (use onfly_search_cities para obter)'),
    check_in: z.string().describe('Data de check-in (YYYY-MM-DD)'),
    check_out: z.string().describe('Data de check-out (YYYY-MM-DD)'),
    rooms: z.number().optional().default(1).describe('Numero de quartos'),
    guests: z.number().optional().default(1).describe('Numero de hospedes por quarto')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var searchBody = {
      type: 'hotel',
      destination: { cityId: params.city_id },
      check_in: params.check_in,
      check_out: params.check_out,
      rooms: [{ adults: params.guests }]
    };

    var result = await gatewayCall('POST', '/bff/quote/create', searchBody);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar hoteis: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          busca_hotel: { cidade_id: params.city_id, checkin: params.check_in, checkout: params.check_out },
          resultado: result.data
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_buses
server.tool(
  'onfly_search_buses',
  'Busca passagens de onibus na Onfly (POST /bff/quote/create)',
  {
    origin: z.string().describe('Origem (use onfly_search_bus_destinations para obter o codigo)'),
    destination: z.string().describe('Destino (use onfly_search_bus_destinations para obter o codigo)'),
    departure_date: z.string().describe('Data de partida (YYYY-MM-DD)')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var searchBody = {
      type: 'bus',
      trips: [{ origin: params.origin, destination: params.destination, departure_date: params.departure_date }]
    };

    var result = await gatewayCall('POST', '/bff/quote/create', searchBody);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar onibus: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          busca_onibus: { origem: params.origin, destino: params.destination, data: params.departure_date },
          resultado: result.data
        }, null, 2)
      }]
    };
  }
);

// Tool: onfly_search_rental_cars
server.tool(
  'onfly_search_rental_cars',
  'Busca aluguel de carros na Onfly (POST /bff/quote/create)',
  {
    pickup_location: z.string().describe('Local de retirada (use onfly_search_rental_car_agencies para obter)'),
    pickup_date: z.string().describe('Data de retirada (YYYY-MM-DD)'),
    return_date: z.string().describe('Data de devolucao (YYYY-MM-DD)')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var searchBody = {
      type: 'rentalCar',
      pickup: { location: params.pickup_location, date: params.pickup_date },
      return: { date: params.return_date }
    };

    var result = await gatewayCall('POST', '/bff/quote/create', searchBody);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar carros: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          busca_carro: { local: params.pickup_location, retirada: params.pickup_date, devolucao: params.return_date },
          resultado: result.data
        }, null, 2)
      }]
    };
  }
);

// ── Gestao de reservas ──────────────────────────────

// Tool: onfly_show_booking
server.tool(
  'onfly_show_booking',
  'Mostra detalhes completos de uma reserva (GET /bff/booking/show/{id})',
  {
    id: z.string().describe('ID da reserva')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('GET', '/bff/booking/show/' + params.id);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao buscar reserva: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result.data.data || result.data, null, 2)
      }]
    };
  }
);

// Tool: onfly_cancel_booking
server.tool(
  'onfly_cancel_booking',
  'Cancela uma reserva (POST /bff/booking/cancel/{bookingId})',
  {
    bookingId: z.string().describe('ID da reserva a cancelar')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('POST', '/bff/booking/cancel/' + params.bookingId, {});

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao cancelar reserva: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'Reserva cancelada com sucesso', bookingId: params.bookingId, detalhes: result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_approve_booking
server.tool(
  'onfly_approve_booking',
  'Aprova uma reserva pendente (POST /bff/booking/{type}/{itemId}/approve)',
  {
    bookingItemType: z.enum(['flight', 'hotel', 'bus', 'rental-car']).describe('Tipo da reserva'),
    itemId: z.string().describe('ID do item da reserva')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('POST', '/bff/booking/' + params.bookingItemType + '/' + params.itemId + '/approve', {});

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao aprovar reserva: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'Reserva aprovada com sucesso', tipo: params.bookingItemType, itemId: params.itemId, detalhes: result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_reprove_booking
server.tool(
  'onfly_reprove_booking',
  'Reprova uma reserva pendente (POST /bff/booking/{type}/{itemId}/reprove)',
  {
    bookingItemType: z.enum(['flight', 'hotel', 'bus', 'rental-car']).describe('Tipo da reserva'),
    itemId: z.string().describe('ID do item da reserva'),
    reason: z.string().optional().describe('Motivo da reprovacao')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var body = {};
    if (params.reason) body.reason = params.reason;

    var result = await gatewayCall('POST', '/bff/booking/' + params.bookingItemType + '/' + params.itemId + '/reprove', body);

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao reprovar reserva: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'Reserva reprovada', tipo: params.bookingItemType, itemId: params.itemId, detalhes: result.data }, null, 2)
      }]
    };
  }
);

// Tool: onfly_list_approvals
server.tool(
  'onfly_list_approvals',
  'Lista aprovacoes pendentes (POST /bff/proxy/approval/pending)',
  {
    page: z.number().optional().default(1).describe('Numero da pagina'),
    perPage: z.number().optional().default(10).describe('Itens por pagina')
  },
  async function (params) {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await gatewayCall('POST', '/bff/proxy/approval/pending', { page: params.page, perPage: params.perPage });

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao listar aprovacoes: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ pagina: params.page, aprovacoes_pendentes: result.data.data || result.data }, null, 2)
      }]
    };
  }
);

// ── Dashboard ───────────────────────────────────────

// Tool: onfly_dashboard
server.tool(
  'onfly_dashboard',
  'Resumo geral do dashboard (gastos, viagens, aprovacoes pendentes)',
  {},
  async function () {
    loadTokens();
    if (!tokenStore.access_token) {
      return { content: [{ type: 'text', text: 'Nao autenticado. Use onfly_connect primeiro.' }] };
    }

    var result = await apiCall('GET', '/general/dashboard');

    if (result.error) {
      return { content: [{ type: 'text', text: 'Erro ao carregar dashboard: ' + JSON.stringify(result.data) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result.data.data || result.data, null, 2)
      }]
    };
  }
);

// Tool: onfly_disconnect
server.tool(
  'onfly_disconnect',
  'Desconecta da Onfly e limpa tokens salvos',
  {},
  async function () {
    tokenStore = {
      access_token: null,
      refresh_token: null,
      expires_at: null,
      user: null,
      gateway_token: null,
      gateway_refresh_token: null,
      gateway_expires_at: null
    };

    try { fs.unlinkSync(TOKEN_FILE); } catch (e) { /* ignore */ }

    return { content: [{ type: 'text', text: 'Desconectado com sucesso. Tokens removidos.' }] };
  }
);

// ── Start ───────────────────────────────────────────
loadTokens();

async function main() {
  var transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(function (e) {
  process.stderr.write('MCP server error: ' + e.message + '\n');
  process.exit(1);
});

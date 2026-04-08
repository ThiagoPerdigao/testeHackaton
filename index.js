require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());







// ── Supabase ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Config ────────────────────────────────────────────
const ONFLY_API_URL    = process.env.ONFLY_API_URL    || 'https://api.onfly.com';
const ONFLY_APP_URL    = process.env.ONFLY_APP_URL    || 'https://app.onfly.com';
const CLIENT_ID        = process.env.ONFLY_CLIENT_ID  || '1212';
const CLIENT_SECRET    = process.env.ONFLY_CLIENT_SECRET;
const REDIRECT_URI     = process.env.REDIRECT_URI     || 'http://localhost:3000/callback';
const FRONTEND_URL     = process.env.FRONTEND_URL     || 'http://localhost:3001';
const PORT             = process.env.PORT             || 3000;

// ── GET /connect ──────────────────────────────────────
// Redireciona o usuário para a tela de consentimento da Onfly
app.get('/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         'travels:read expenses:read',
    state:         'onfly_' + Math.random().toString(36).substring(2, 10),
  });

  const authorizeUrl = `${ONFLY_APP_URL}/v2#/auth/oauth/authorize?${params.toString()}`;
  res.redirect(authorizeUrl);
});

// ── GET /callback ─────────────────────────────────────
// Recebe o authorization code da Onfly, troca por token e salva no Supabase
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).json({ error: error || 'missing_code' });
  }

  try {
    // Troca o code pelo access token
    const tokenResp = await axios.post(
      `${ONFLY_API_URL}/oauth/token`,
      {
        grant_type:    'authorization_code',
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
      },
      { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );

    const { access_token, refresh_token, expires_in } = tokenResp.data;

    // Busca dados do usuário logado
    let user_name = null;
    let company_id = null;
    try {
      const userResp = await axios.get(`${ONFLY_API_URL}/bff/user/logged`, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/prs.onfly.v1+json',
        },
      });
      user_name  = userResp.data?.name  || userResp.data?.data?.name  || null;
      company_id = userResp.data?.company_id || userResp.data?.data?.company_id || null;
    } catch (_) {
      // continua mesmo sem os dados do usuário
    }

    const expires_at = expires_in
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : null;

    // Salva no Supabase
    const { data, error: dbError } = await supabase
      .from('tokens')
      .insert({ token: access_token, user_name, company_id, expires_at })
      .select()
      .single();

    if (dbError) throw dbError;

    // Redireciona pro front com sucesso
    const redirectUrl = `${FRONTEND_URL}?success=true&id=${data.id}`;
    res.redirect(redirectUrl);

  } catch (err) {
    console.error('callback error:', err.response?.data || err.message);
    res.status(500).json({ error: 'auth_failed', detail: err.response?.data || err.message });
  }
});

// ── POST /tokens ──────────────────────────────────────
// Salva um token diretamente (sem OAuth — útil para testes e integração manual)
app.post('/tokens', async (req, res) => {
  const { token, user_name, company_id, expires_at } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'token is required' });
  }

  const { data, error } = await supabase
    .from('tokens')
    .insert({ token, user_name: user_name || null, company_id: company_id || null, expires_at: expires_at || null })
    .select()
    .single();

  if (error) {
    console.error('insert error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// ── GET /tokens ───────────────────────────────────────
// Lista todos os tokens — consumido pelo n8n
app.get('/tokens', async (req, res) => {
  const { data, error } = await supabase
    .from('tokens')
    .select('id, token, user_name, company_id, created_at, expires_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('select error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Auth service running on http://localhost:${PORT}`);
  console.log(`  GET  /connect   → inicia OAuth Onfly`);
  console.log(`  GET  /callback  → callback OAuth (redirect_uri: ${REDIRECT_URI})`);
  console.log(`  POST /tokens    → salva token manualmente`);
  console.log(`  GET  /tokens    → lista todos os tokens (n8n)`);
});

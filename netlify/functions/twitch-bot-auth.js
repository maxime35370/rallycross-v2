/* ═══════════════════════════════════════════════
   TWITCH-BOT-AUTH.JS — Pont OAuth Twitch pour le BOT DE CHAT (régie
   uniquement), distinct de twitch-auth.js (identité spectateur/régie).

   Pourquoi une fonction séparée : ce flux demande le scope
   `user:write:chat` (poster dans le chat AU NOM du compte Twitch de la
   régie) — un pouvoir bien plus sensible qu'une simple identité de
   spectateur. Il est donc :
     - réservé au compte régie (email vérifié côté serveur, pas seulement
       "connecté") ;
     - stocké dans un document `twitchBotAuth/main` interdit en lecture ET
       écriture aux clients (cf. firestore.rules) — seule cette fonction et
       twitch-chat-post.js (Admin SDK) y touchent, jamais le navigateur.

   Flux (déclenché depuis overlay/control.html, cf. obs-twitch-bot.js) :
   1. Le navigateur (régie déjà connectée) redirige vers Twitch avec
      scope=user:write:chat, redirect_uri = CETTE fonction.
   2. Twitch redirige ICI (GET ?code&state) → page pont (même origine, donc
      accès à la session régie déjà ouverte) qui vérifie `state`, récupère
      le jeton d'identité Firebase courant, et POST ce jeton + le code à
      cette même fonction.
   3. Ce POST est traité ICI : jeton vérifié (Admin SDK) + email régie
      exigé, code échangé, profil Twitch lu, puis access/refresh token +
      login stockés dans twitchBotAuth/main (secret) et un statut
      public-safe (pas de jeton) dans twitchBotStatus/main, pour que le
      panneau régie affiche « connecté en tant que … » sans jamais lire le
      jeton lui-même.
═══════════════════════════════════════════════ */

import admin from 'firebase-admin';

const REDIRECT_URI = 'https://rxchrono.netlify.app/.netlify/functions/twitch-bot-auth';
const REGIE_EMAIL = 'maxime.theard@gmail.com';   // même compte que isRegie() côté règles Firestore
const BOT_SCOPE = 'user:write:chat';

let _app = null;
function adminApp() {
  if (!_app) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    _app = admin.initializeApp({ credential: admin.credential.cert(svc) }, 'twitch-bot-auth');
  }
  return _app;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('twitch_token_exchange_failed');
  return r.json();
}

async function fetchTwitchUser(accessToken) {
  const r = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID },
  });
  if (!r.ok) throw new Error('twitch_user_fetch_failed');
  const data = await r.json();
  const u = data.data && data.data[0];
  if (!u) throw new Error('twitch_user_missing');
  return u;
}

/** Page pont servie sur le retour Twitch (GET). Revient sur la régie, jamais de changement d'identité Firebase ici. */
function bridgeHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Connexion du bot Twitch…</title>
<p style="font:15px system-ui,sans-serif;color:#8b95a4;padding:32px;text-align:center">Connexion du bot Twitch…</p>
<script type="module">
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';
  const CONFIG = {
    apiKey: "AIzaSyBv2Fh-YDX1kEnKHWxQhxXYl_x5EwRrk1E",
    authDomain: "rallycross-1512f.firebaseapp.com",
    projectId: "rallycross-1512f",
    storageBucket: "rallycross-1512f.firebasestorage.app",
    messagingSenderId: "123635957863",
    appId: "1:123635957863:web:f229eb25637dd0656794c2",
  };
  const qs = new URLSearchParams(location.search);
  const code = qs.get('code'), state = qs.get('state'), twitchErr = qs.get('error');
  const nonce = sessionStorage.getItem('rxTwitchBotNonce') || '';
  const returnPath = sessionStorage.getItem('rxTwitchBotReturnPath') || '/overlay/control.html';
  sessionStorage.removeItem('rxTwitchBotNonce');
  sessionStorage.removeItem('rxTwitchBotReturnPath');

  function goBack(result) {
    sessionStorage.setItem('rxTwitchBotResult', result);
    location.replace(returnPath);
  }

  (async () => {
    if (twitchErr) return goBack('error:' + twitchErr);
    if (!code || !state || state !== nonce) return goBack('error:state');
    try {
      const { initializeApp, getApps } = await import(SDK + 'firebase-app.js');
      const { getAuth, onAuthStateChanged } = await import(SDK + 'firebase-auth.js');
      const app = getApps()[0] || initializeApp(CONFIG);
      const auth = getAuth(app);
      await new Promise(res => { const off = onAuthStateChanged(auth, () => { off(); res(); }); });
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
      if (!idToken) return goBack('error:no-session');
      const r = await fetch('/.netlify/functions/twitch-bot-auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, idToken }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) return goBack('error:' + (data.error || 'exchange'));
      goBack('ok');
    } catch (e) { goBack('error:exception'); }
  })();
</script>`;
}

export default async (req) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('start') === '1') {
      // Point d'entrée pratique (pas utilisé par le client actuel, qui construit
      // lui-même l'URL Twitch — gardé pour du débogage manuel éventuel).
      return jsonResponse({ error: 'use_client_flow' }, 400);
    }
    return new Response(bridgeHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { code, idToken } = await req.json();
    if (!code || !idToken) return jsonResponse({ error: 'missing_params' }, 400);

    const app = adminApp();
    const decoded = await admin.auth(app).verifyIdToken(idToken);
    if ((decoded.email || '') !== REGIE_EMAIL) {
      return jsonResponse({ error: 'not_regie' }, 403);
    }

    const tokenData = await exchangeCode(code);
    const grantedScopes = (tokenData.scope || []).join(' ');
    if (!grantedScopes.includes(BOT_SCOPE)) {
      return jsonResponse({ error: 'missing_scope' }, 400);
    }
    const twitchUser = await fetchTwitchUser(tokenData.access_token);
    const db = admin.firestore(app);

    await db.collection('twitchBotAuth').doc('main').set({
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt:    Date.now() + (tokenData.expires_in || 0) * 1000,
      broadcasterId:    twitchUser.id,
      broadcasterLogin: twitchUser.login,
      scope: grantedScopes,
      updatedAt: Date.now(),
    });
    await db.collection('twitchBotStatus').doc('main').set({
      connected: true,
      login: twitchUser.login,
      displayName: twitchUser.display_name,
      updatedAt: Date.now(),
    });

    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('[twitch-bot-auth]', e);
    return jsonResponse({ error: 'server_error' }, 500);
  }
};

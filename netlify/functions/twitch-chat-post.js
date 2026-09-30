/* ═══════════════════════════════════════════════
   TWITCH-CHAT-POST.JS — Poste un message dans le chat Twitch de la régie,
   au nom du compte connecté via twitch-bot-auth.js (scope user:write:chat).

   Appelée en « fire-and-forget » depuis overlay/_lib/obs-pronostics.js à
   chaque ouverture/fermeture/révélation de pronostic (manuelle ou
   automatisée, cf. obs-prono-auto.js) — jamais bloquante : un échec ici ne
   doit JAMAIS empêcher l'action régie elle-même.

   Sécurité : le jeton Twitch (accès + refresh) ne quitte JAMAIS le serveur
   — ni le code, ni la réponse. Le jeton Firebase de l'appelant est vérifié
   et DOIT être celui de la régie (même email que twitch-bot-auth.js),
   sinon n'importe qui pourrait faire parler le chat de la chaîne.
═══════════════════════════════════════════════ */

import admin from 'firebase-admin';

const REGIE_EMAIL = 'maxime.theard@gmail.com';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // renouvelle un peu avant l'expiration réelle

let _app = null;
function adminApp() {
  if (!_app) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    _app = admin.initializeApp({ credential: admin.credential.cert(svc) }, 'twitch-chat-post');
  }
  return _app;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function refreshAccessToken(refreshTok) {
  const body = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshTok,
  });
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error('twitch_refresh_failed');
  return r.json();
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { idToken, message } = await req.json();
    if (!idToken || !message) return jsonResponse({ error: 'missing_params' }, 400);

    const app = adminApp();
    const decoded = await admin.auth(app).verifyIdToken(idToken);
    if ((decoded.email || '') !== REGIE_EMAIL) return jsonResponse({ error: 'not_regie' }, 403);

    const db = admin.firestore(app);
    const ref = db.collection('twitchBotAuth').doc('main');
    let auth = (await ref.get()).data();
    if (!auth?.accessToken || !auth?.broadcasterId) return jsonResponse({ error: 'bot_not_connected' }, 400);

    if (Date.now() > (auth.expiresAt || 0) - REFRESH_MARGIN_MS) {
      const fresh = await refreshAccessToken(auth.refreshToken);
      auth = {
        ...auth,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token || auth.refreshToken,
        expiresAt: Date.now() + (fresh.expires_in || 0) * 1000,
        updatedAt: Date.now(),
      };
      await ref.set(auth, { merge: true });
    }

    const r = await fetch('https://api.twitch.tv/helix/chat/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: auth.broadcasterId,
        sender_id: auth.broadcasterId,
        message: String(message).slice(0, 500),
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[twitch-chat-post] helix', r.status, text);
      return jsonResponse({ error: 'twitch_send_failed' }, 502);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error('[twitch-chat-post]', e);
    return jsonResponse({ error: 'server_error' }, 500);
  }
};

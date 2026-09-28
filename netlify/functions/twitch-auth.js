/* ═══════════════════════════════════════════════
   TWITCH-AUTH.JS — Pont OAuth Twitch ↔ compte pronostics anonyme.

   Pourquoi une fonction serveur : l'échange du code Twitch exige le Client
   Secret, qui ne doit JAMAIS atteindre le navigateur. Cette fonction est le
   SEUL endroit où il est lu (variable d'environnement Netlify).

   Flux complet (voir js/spectator.js pour le déclenchement) :
   1. Le navigateur redirige vers Twitch avec redirect_uri = CETTE fonction.
   2. Twitch redirige le navigateur ICI avec ?code&state (requête GET) →
      on répond avec une petite page pont (même origine que le site, donc
      elle retrouve la session anonyme déjà ouverte via IndexedDB) qui :
        a) vérifie le paramètre `state` (anti-CSRF, comparé au nonce posé
           avant le départ vers Twitch) ;
        b) récupère le jeton d'identité Firebase de la session anonyme EN
           COURS dans CE navigateur ;
        c) POST ce jeton + le code Twitch à cette même fonction.
   3. Ce POST est traité ICI, côté serveur : le jeton anonyme est vérifié
      (Admin SDK — infalsifiable), le code Twitch est échangé, le profil
      Twitch est lu, puis on écrit :
        - twitchProfiles/{twitch_<id>}  (profil, lecture publique)
        - uidLinks/{ancienUidAnonyme}   (pointeur vers le compte Twitch)
      Ces deux écritures passent par l'Admin SDK, donc HORS règles Firestore
      — c'est justement pourquoi les règles interdisent tout write client sur
      ces deux collections : seule cette fonction, qui a vérifié le jeton,
      peut les produire.
   4. Un jeton personnalisé Firebase est renvoyé ; la page pont l'utilise
      pour basculer la session du navigateur sur le uid Twitch stable, puis
      revient sur la page spectateur.

   Aucune donnée de vote n'est jamais réécrite : le rattachement se fait par
   RÉSOLUTION (uidLinks) au moment du calcul des classements, jamais par
   migration des documents existants (votes: delete est de toute façon
   refusé par les règles).
═══════════════════════════════════════════════ */

import admin from 'firebase-admin';

const REDIRECT_URI = 'https://rxchrono.netlify.app/.netlify/functions/twitch-auth';

let _app = null;
function adminApp() {
  if (!_app) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    _app = admin.initializeApp({ credential: admin.credential.cert(svc) });
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

/** Page pont servie sur le retour Twitch (GET). Même origine que le site → accès à la session anonyme locale. */
function bridgeHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Connexion Twitch…</title>
<p style="font:15px system-ui,sans-serif;color:#8b95a4;padding:32px;text-align:center">Connexion à Twitch…</p>
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
  const nonce = sessionStorage.getItem('rxTwitchNonce') || '';
  const returnHash = sessionStorage.getItem('rxTwitchReturnHash') || '#spectator';
  sessionStorage.removeItem('rxTwitchNonce');
  sessionStorage.removeItem('rxTwitchReturnHash');

  function goBack(result) {
    sessionStorage.setItem('rxTwitchResult', result);
    location.replace('/' + returnHash);
  }

  (async () => {
    if (twitchErr) return goBack('error:' + twitchErr);
    if (!code || !state || state !== nonce) return goBack('error:state');
    try {
      const { initializeApp, getApps } = await import(SDK + 'firebase-app.js');
      const { getAuth, onAuthStateChanged, signInWithCustomToken } = await import(SDK + 'firebase-auth.js');
      const app = getApps()[0] || initializeApp(CONFIG);
      const auth = getAuth(app);
      await new Promise(res => { const off = onAuthStateChanged(auth, () => { off(); res(); }); });
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
      if (!idToken) return goBack('error:no-session');
      const r = await fetch('/.netlify/functions/twitch-auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, idToken }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.customToken) return goBack('error:' + (data.error || 'exchange'));
      await signInWithCustomToken(auth, data.customToken);
      goBack('ok');
    } catch (e) { goBack('error:exception'); }
  })();
</script>`;
}

export default async (req) => {
  if (req.method === 'GET') {
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
    const anonUid = decoded.uid;
    // On ne relie qu'une VRAIE session anonyme de pronostics — jamais un
    // compte régie (email/mot de passe), qui n'a rien à voir ici.
    if (decoded.firebase?.sign_in_provider !== 'anonymous') {
      return jsonResponse({ error: 'not_anonymous' }, 403);
    }

    const tokenData = await exchangeCode(code);
    const twitchUser = await fetchTwitchUser(tokenData.access_token);
    const twitchUid = `twitch_${twitchUser.id}`;

    const db = admin.firestore(app);
    const profileRef = db.collection('twitchProfiles').doc(twitchUid);
    const existing = (await profileRef.get()).data();
    const linkedFrom = new Set(existing?.linkedFrom || []);
    linkedFrom.add(anonUid);

    await profileRef.set({
      login: twitchUser.login,
      displayName: twitchUser.display_name,
      avatarUrl: twitchUser.profile_image_url || '',
      linkedFrom: [...linkedFrom],
      updatedAt: Date.now(),
    }, { merge: true });

    // Si l'uid courant est déjà le uid Twitch canonique (reconnexion), pas de
    // lien à créer vers lui-même.
    if (anonUid !== twitchUid) {
      await db.collection('uidLinks').doc(anonUid).set({ canonicalUid: twitchUid, linkedAt: Date.now() });
    }

    const customToken = await admin.auth(app).createCustomToken(twitchUid, { twitch: true });
    return jsonResponse({ customToken });
  } catch (e) {
    console.error('[twitch-auth]', e);
    return jsonResponse({ error: 'server_error' }, 500);
  }
};

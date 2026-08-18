/* ═══════════════════════════════════════════════
   SERVICE WORKER — Cache offline pour RX Chrono
   Strategie : cache-first pour les assets statiques,
   network-first pour les requetes Firebase.
   Compatible GitHub Pages (sous-dossier) et racine.
═══════════════════════════════════════════════ */

const CACHE_NAME = 'rx-chrono-v29';

// Assets relatifs au scope du SW (pas de / en prefixe)
const ASSET_PATHS = [
  'index.html',
  'manifest.json',
  'css/theme.css',
  'css/main.css',
  'css/components.css',
  'css/modules/championship.css',
  'css/modules/meetings.css',
  'css/modules/drivers.css',
  'css/modules/standings.css',
  'css/modules/sessions.css',
  'css/modules/timing.css',
  'css/modules/stats.css',
  'css/modules/driverProfile.css',
  'css/modules/engagements.css',
  'css/modules/spectator.css',
  'css/modules/settings.css',
  'css/modules/startAnalysis.css',
  'js/app.js',
  'js/firebase.js',
  'js/auth.js',
  'js/config.js',
  'js/utils.js',
  'js/calc.js',
  'js/drivers.js',
  'js/meetings.js',
  'js/engagements.js',
  'js/sessions.js',
  'js/timing.js',
  'js/standings.js',
  'js/championship.js',
  'js/stats.js',
  'js/spectator.js',
  'js/driverProfile.js',
  'js/settings.js',
  'js/audit.js',
  'js/qrcode.js',
  'js/context.js',
  'js/competition.js',
  'js/importTimes.js',
  'js/videoTimecodes.js',
  'js/persons.js',
  'js/personProfile.js',
  'js/startAnalysisCalc.js',
  'js/startAnalysis.js',
  'js/startStatsCalc.js',
  'js/providers/index.js',
  'js/providers/itsLive.js',
];

// ── Installation : pre-cache des assets statiques ──
self.addEventListener('install', (event) => {
  // Construire les URLs relatives au scope du SW
  const base = self.registration.scope;
  const urls = ASSET_PATHS.map((p) => new URL(p, base).href);

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache chaque fichier individuellement pour ne pas bloquer si un echoue
      Promise.allSettled(urls.map((url) =>
        cache.add(url).catch((err) => console.warn('SW cache skip:', url, err.message))
      ))
    )
  );
  self.skipWaiting();
});

// ── Activation : nettoyage des vieux caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch : strategie selon le type de requete ──
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ne gérer que les GET http(s). On laisse passer le reste (POST/écritures,
  // chrome-extension://, etc.) → évite l'erreur "Request scheme is unsupported".
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Google Fonts : cache-first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return response;
        })
      )
    );
    return;
  }

  // Firebase / Firestore / Auth / SDK : NE PAS intercepter.
  // Le streaming Listen de Firestore et les tokens d'auth ne supportent pas
  // d'être ré-emballés par le SW (sinon "Failed to convert value to Response").
  // On laisse le navigateur gérer nativement.
  if (/\.googleapis\.com$|\.gstatic\.com$|firebaseio\.com$/.test(url.hostname)) {
    return;
  }

  // Overlays : network-first → les mises à jour se déploient immédiatement.
  if (url.pathname.includes('/overlay/')) {
    event.respondWith(
      fetch(req).then((response) => {
        if (response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Assets statiques locaux (HTML/JS/CSS) : NETWORK-FIRST → les mises à jour
  // déployées sont prises en compte immédiatement (fini le JS servi périmé après
  // un merge). Repli sur le cache uniquement hors-ligne.
  event.respondWith(
    fetch(req).then((response) => {
      if (response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return response;
    }).catch(() => caches.match(req))
  );
});

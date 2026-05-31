/* ═══════════════════════════════════════════════
   SERVICE WORKER — Cache offline pour RX Chrono
   Strategie : cache-first pour les assets statiques,
   network-first pour les requetes Firebase.
   Compatible GitHub Pages (sous-dossier) et racine.
═══════════════════════════════════════════════ */

const CACHE_NAME = 'rx-chrono-v18';

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
  const url = new URL(event.request.url);

  // Firebase / API : network-first (ne pas cacher les donnees dynamiques)
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Google Fonts : cache-first
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            return response;
          })
      )
    );
    return;
  }

  // Assets statiques locaux : cache-first, fallback network
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          // Ne cacher que les reponses valides
          if (response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
    )
  );
});

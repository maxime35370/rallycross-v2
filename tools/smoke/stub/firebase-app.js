/* Stub minimal du SDK firebase-app, pour le smoke test hors ligne.
   Ne sert QUE tools/smoke/projectionSmoke.mjs : l'environnement de test n'a
   pas accès à gstatic.com, mais l'application doit tout de même être exercée
   dans un vrai navigateur avec de vraies données. */

const apps = [];
export function initializeApp(config) { const app = { options: config }; apps.push(app); return app; }
export function getApps() { return apps.slice(); }
export function deleteApp(app) { const i = apps.indexOf(app); if (i >= 0) apps.splice(i, 1); }

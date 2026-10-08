import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  // Les modules de l'app chargent le SDK Firestore depuis un CDN (import
  // dynamique d'une URL https), que Node ne sait pas résoudre. Pour compter les
  // lectures sans réseau, ce module précis est remplacé par un faux en mémoire.
  resolve: {
    alias: {
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js':
        new URL('./tests/helpers/fakeFirestore.js', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    // `tools/` contient des bancs de mesure isolés (POC vidéo) qui utilisent
    // `node:test` et leurs propres dépendances. Les laisser dans le champ de
    // Vitest casse `npm test` à la racine : Vitest charge le fichier, n'y
    // trouve pas de suite à son format, et échoue. Ils se lancent depuis leur
    // propre dossier (`npm test` dans tools/video-poc).
    // `tests/rules/` exige l'émulateur Firestore et une JVM : ces tests ont
    // leur propre configuration et leur propre script (`npm run test:rules`).
    exclude: [...configDefaults.exclude, 'tools/**', 'tests/rules/**'],
  },
});

import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `tools/` contient des bancs de mesure isolés (POC vidéo) qui utilisent
    // `node:test` et leurs propres dépendances. Les laisser dans le champ de
    // Vitest casse `npm test` à la racine : Vitest charge le fichier, n'y
    // trouve pas de suite à son format, et échoue. Ils se lancent depuis leur
    // propre dossier (`npm test` dans tools/video-poc).
    exclude: [...configDefaults.exclude, 'tools/**'],
  },
});

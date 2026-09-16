import { defineConfig } from 'vitest/config';

/* Configuration DÉDIÉE aux tests de règles Firestore.
   Ils exigent l'émulateur en marche et une JVM ; les inclure dans `npm test`
   rendrait la suite ordinaire dépendante de Java. On les lance donc à part :
       npm run test:rules
   qui démarre l'émulateur, exécute cette configuration, puis l'arrête. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.js'],
    // Les règles sont un état partagé : deux fichiers en parallèle se
    // marcheraient dessus dans la même base émulée.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

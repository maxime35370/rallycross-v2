import { describe, it, expect } from 'vitest';
import {
  CANAL_ANALYSE, MSG_GRILLE, MSG_CLASSEMENT,
  messageGrille, messageClassement, messagePour, ouvrirCanal,
} from '../js/analysisLink.js';

// ─────────────────────────────────────────────────────────
// CANAL FACTICE
// BroadcastChannel n'existe pas sous Node : on injecte une fabrique qui
// relie entre eux tous les canaux portant le même nom, exactement comme le
// navigateur relie deux onglets de même origine.
// ─────────────────────────────────────────────────────────
function fabriqueLocale() {
  const bus = new Map();                     // nom → Set de canaux
  const fabrique = (nom) => {
    const canal = {
      nom, onmessage: null, ferme: false,
      postMessage(msg) {
        if (canal.ferme) throw new Error('canal fermé');
        // Un BroadcastChannel ne se renvoie jamais ses propres messages.
        for (const autre of bus.get(nom)) {
          if (autre !== canal && !autre.ferme) autre.onmessage?.({ data: msg });
        }
      },
      close() { canal.ferme = true; bus.get(nom).delete(canal); },
    };
    if (!bus.has(nom)) bus.set(nom, new Set());
    bus.get(nom).add(canal);
    return canal;
  };
  fabrique.bus = bus;
  return fabrique;
}

const GRILLE = {
  format: 'rx-start-grid/1',
  startId: 'D3-Q3-S4',
  poleSide: 'left',
  rows: [
    { gridPos: 1, lane: 1, number: 12, name: 'C. Nauy', driverId: 'd12' },
    { gridPos: 2, lane: 3, number: 7,  name: 'L. Morel', driverId: 'd7' },
  ],
};

// ─────────────────────────────────────────────────────────
describe('messageGrille — ce que l\'application envoie à l\'outil', () => {
  it('porte le type, la grille, le fichier et les deux timecodes', () => {
    const file = { name: 'depart.mp4', size: 29_200_000 };   // un File est clonable
    const m = messageGrille({ grid: GRILLE, file, startAt: 3, turn1At: 13.5 });

    expect(m.type).toBe(MSG_GRILLE);
    expect(m.grid).toBe(GRILLE);
    expect(m.file).toBe(file);
    expect(m.startAt).toBe(3);
    expect(m.turn1At).toBe(13.5);
    expect(typeof m.envoi).toBe('number');
  });

  it('emporte le sidecar : la cadence relevée à l\'extraction vaut mieux que devinée', () => {
    const sc = { schema: 'rx-extract/1', fps: 60, file: 'depart.mp4' };
    expect(messageGrille({ grid: GRILLE, sidecar: sc }).sidecar).toBe(sc);
    expect(messageGrille({ grid: GRILLE }).sidecar).toBeNull();
  });

  it('hérite du startId de la grille quand on ne le précise pas', () => {
    expect(messageGrille({ grid: GRILLE }).startId).toBe('D3-Q3-S4');
  });

  it('le startId explicite prime sur celui de la grille', () => {
    expect(messageGrille({ grid: GRILLE, startId: 'autre' }).startId).toBe('autre');
  });

  it('accepte un timecode nul : 0 s est une valeur, pas une absence', () => {
    const m = messageGrille({ grid: GRILLE, startAt: 0, turn1At: '13.5' });
    expect(m.startAt).toBe(0);
    expect(m.turn1At).toBe(13.5);      // une chaîne numérique reste exploitable
  });

  it('refuse un timecode illisible plutôt que de propager NaN', () => {
    const m = messageGrille({ grid: GRILLE, startAt: 'bientôt', turn1At: undefined });
    expect(m.startAt).toBeNull();
    expect(m.turn1At).toBeNull();
  });

  it('sans argument, ne jette pas et ne prétend rien', () => {
    const m = messageGrille();
    expect(m.type).toBe(MSG_GRILLE);
    expect(m.grid).toBeNull();
    expect(m.startId).toBeNull();
  });
});

describe('messageClassement — ce que l\'outil renvoie', () => {
  it('transporte le document tel quel', () => {
    const doc = { format: 'rx-v1-order/1', order: [12, 7] };
    const m = messageClassement({ doc, startId: 'D3-Q3-S4' });
    expect(m.type).toBe(MSG_CLASSEMENT);
    expect(m.doc).toBe(doc);
    expect(m.startId).toBe('D3-Q3-S4');
  });
});

describe('messagePour — filtre d\'écoute', () => {
  const m = messageClassement({ doc: {}, startId: 'D3-Q3-S4' });

  it('retient un message du bon type et du bon départ', () => {
    expect(messagePour(m, MSG_CLASSEMENT, 'D3-Q3-S4')).toBe(true);
  });

  it('écarte un message d\'un autre type', () => {
    expect(messagePour(m, MSG_GRILLE, 'D3-Q3-S4')).toBe(false);
  });

  it('écarte le classement d\'un AUTRE départ — deux onglets ne se contaminent pas', () => {
    expect(messagePour(m, MSG_CLASSEMENT, 'D3-Q4-S1')).toBe(false);
  });

  it('sans départ attendu, retient tout message du bon type', () => {
    expect(messagePour(m, MSG_CLASSEMENT)).toBe(true);
  });

  it('retient un message sans départ : l\'outil peut répondre avant de savoir', () => {
    const anonyme = messageClassement({ doc: {} });
    expect(messagePour(anonyme, MSG_CLASSEMENT, 'D3-Q3-S4')).toBe(true);
  });

  it('compare les identifiants comme des textes : 12 et \'12\' sont le même départ', () => {
    const num = messageClassement({ doc: {}, startId: 12 });
    expect(messagePour(num, MSG_CLASSEMENT, '12')).toBe(true);
  });

  it('ne jette pas sur un message vide', () => {
    expect(messagePour(null, MSG_CLASSEMENT)).toBe(false);
    expect(messagePour({}, MSG_CLASSEMENT)).toBe(false);
  });
});

describe('ouvrirCanal — le pont lui-même', () => {
  it('utilise le nom de canal partagé par les deux documents', () => {
    const f = fabriqueLocale();
    ouvrirCanal(f);
    expect([...f.bus.keys()]).toEqual([CANAL_ANALYSE]);
  });

  it('un document reçoit ce que l\'autre poste', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const outil = ouvrirCanal(f);
    const recus = [];
    outil.ecouter((m) => recus.push(m));

    const envoye = messageGrille({ grid: GRILLE, startAt: 3, turn1At: 13.5 });
    app.poster(envoye);

    expect(recus).toEqual([envoye]);
  });

  it('le fichier vidéo voyage par référence : aucun octet sur le réseau', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const outil = ouvrirCanal(f);
    const file = { name: 'depart.mp4', size: 29_200_000 };
    let recu = null;
    outil.ecouter((m) => { recu = m; });

    app.poster(messageGrille({ grid: GRILLE, file }));

    expect(recu.file).toBe(file);
  });

  it('l\'expéditeur ne s\'écoute pas lui-même', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const recus = [];
    app.ecouter((m) => recus.push(m));
    app.poster(messageGrille({ grid: GRILLE }));
    expect(recus).toEqual([]);
  });

  it('sert plusieurs abonnés du même document', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const outil = ouvrirCanal(f);
    const a = [], b = [];
    outil.ecouter((m) => a.push(m));
    outil.ecouter((m) => b.push(m));
    app.poster(messageClassement({ doc: { ok: true } }));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('se désabonner arrête la réception sans fermer le canal', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const outil = ouvrirCanal(f);
    const recus = [], autres = [];
    const stop = outil.ecouter((m) => recus.push(m));
    outil.ecouter((m) => autres.push(m));

    stop();
    app.poster(messageClassement({ doc: {} }));

    expect(recus).toEqual([]);
    expect(autres).toHaveLength(1);
  });

  it('fermer coupe l\'écoute', () => {
    const f = fabriqueLocale();
    const app = ouvrirCanal(f);
    const outil = ouvrirCanal(f);
    const recus = [];
    outil.ecouter((m) => recus.push(m));

    outil.fermer();
    app.poster(messageClassement({ doc: {} }));

    expect(recus).toEqual([]);
  });

  it('fermer deux fois ne jette pas', () => {
    const f = fabriqueLocale();
    const canal = ouvrirCanal(f);
    canal.fermer();
    expect(() => canal.fermer()).not.toThrow();
  });

  it('sans fabrique, prend le BroadcastChannel du navigateur', () => {
    const canal = ouvrirCanal();
    expect(canal).not.toBeNull();
    canal.fermer();
  });

  it('rend null quand BroadcastChannel n\'existe pas — l\'appelant retombe sur les fichiers', () => {
    // Navigateur ancien, ou contexte où l'API est refusée : le pont doit se
    // taire, pas jeter. L'écran d'analyse garde alors l'export/import.
    const vrai = globalThis.BroadcastChannel;
    delete globalThis.BroadcastChannel;
    try {
      expect(ouvrirCanal()).toBeNull();
    } finally {
      globalThis.BroadcastChannel = vrai;
    }
  });
});

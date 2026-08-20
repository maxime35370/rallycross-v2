#!/bin/sh
# PASSE DE VALIDATION COMPLÈTE — à exécuter avant toute mise en production.
#
# Enchaîne l'ensemble des contrôles et s'arrête au premier échec. Chaque étape
# est indépendante et peut être relancée seule ; l'ordre va du moins coûteux au
# plus coûteux, pour échouer vite.
#
# Usage : sh tools/valider.sh [révision-de-référence]
set -e
cd "$(dirname "$0")/.."
BASE="${1:-origin/main}"
CHROMIUM="${CHROMIUM_PATH:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"

etape() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

etape "1/7 · tests unitaires"
npx vitest run

etape "2/7 · non-régression Classements / Championnat / Chronométrage"
sh tools/qualification-audit/16-non-regression.sh "$(git merge-base HEAD "$BASE")"
node tools/qualification-audit/16-non-regression.mjs

etape "3/7 · statuts DNF / DNS / DSQ / DSQ_RACE"
node tools/qualification-audit/10-statuts.mjs | tail -20

etape "4/7 · replay de tous les meetings réels"
node tools/qualification-audit/15-replay.mjs 40

etape "5/7 · smoke application"
CHROMIUM_PATH="$CHROMIUM" node tools/smoke/smoke.mjs | tail -3

etape "6/7 · smoke projection"
CHROMIUM_PATH="$CHROMIUM" node tools/smoke/projectionSmoke.mjs | tail -3

etape "7/8 · smoke manche en cours + objectif"
CHROMIUM_PATH="$CHROMIUM" node tools/smoke/liveRaceSmoke.mjs | tail -3

etape "8/8 · capture de l'écran opérationnel"
# Contrôle visuel : le rendu d'un écran ne se vérifie pas dans un test unitaire.
CHROMIUM_PATH="$CHROMIUM" node tools/smoke/captureStrategie.mjs 3 374 | tail -14

printf '\n\033[1;32m✅ passe de validation complète : tout est vert.\033[0m\n'

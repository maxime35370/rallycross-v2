#!/bin/sh
# Extrait la révision de référence de calc.js/utils.js et neutralise ses accès
# Firestore, pour comparer l'ancien et le nouveau code sur les MÊMES données.
#
# Les fichiers produits (js/__base*.js) sont temporaires et ne doivent jamais
# être versionnés — 16-non-regression.mjs les supprime après usage.
#
# Usage : sh tools/qualification-audit/16-non-regression.sh <révision>
set -e
BASE="${1:?révision de référence attendue}"
cd "$(dirname "$0")/../.."

git show "$BASE:js/calc.js"  > js/__baseCalc.js
git show "$BASE:js/utils.js" > js/__baseUtils.js
sed -i "s|from './utils.js'|from './__baseUtils.js'|g" js/__baseCalc.js

# Les deux chargeurs Firestore sont remplacés par une lecture d'un jeu de
# données injecté. Le RESTE du fichier — barèmes, tri, départages — est
# rigoureusement celui de la révision de référence.
python3 - <<'PY'
import re
p = 'js/__baseCalc.js'
s = open(p).read()
for nom, cle in (('getResults', '__RESULTS__'), ('getParticipants', '__PARTICIPANTS__')):
    s = re.sub(
        r'export async function %s\(db, sessionId\) \{.*?\n\}' % nom,
        'export async function %s(_db, sessionId) {\n'
        '  return (globalThis.%s || {})[sessionId] || [];\n}' % (nom, cle),
        s, count=1, flags=re.S)
open(p, 'w').write(s)
PY
echo "js/__baseCalc.js et js/__baseUtils.js prêts (référence $BASE)."

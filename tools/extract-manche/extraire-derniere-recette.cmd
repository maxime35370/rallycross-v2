@echo off
rem ===============================================
rem  EXTRAIRE-DERNIERE-RECETTE.CMD
rem
rem  Double-clic unique : va chercher la recette la plus recente telechargee
rem  depuis "Analyse des departs", et extrait la manche.
rem
rem  Pourquoi ce fichier plutot qu'un .cmd telecharge a chaque fois :
rem  Windows marque tout script venu du web et affiche un avertissement a
rem  CHAQUE execution. Ce fichier-ci vit sur le disque, il n'est jamais
rem  telecharge, donc aucun avertissement. Seules les recettes voyagent, et
rem  une recette est un fichier de donnees, pas un programme.
rem
rem  Usage : cree un raccourci vers ce fichier sur le Bureau ou la barre des
rem  taches. Ensuite : un clic sur le site, un double-clic ici.
rem
rem  Ce fichier est volontairement en ASCII pur : un .cmd accentue se lit mal
rem  selon la page de codes active, et peut casser l'analyse de la commande.
rem
rem  Dossier fouille : %USERPROFILE%\Downloads par defaut. Pour un autre
rem  dossier, passe-le en argument ou definis RX_TELECHARGEMENTS.
rem ===============================================
setlocal EnableDelayedExpansion

set "DOSSIER=%~1"
if "%DOSSIER%"=="" set "DOSSIER=%RX_TELECHARGEMENTS%"
if "%DOSSIER%"=="" set "DOSSIER=%USERPROFILE%\Downloads"

if not exist "%DOSSIER%" (
  echo.
  echo   X Dossier introuvable : %DOSSIER%
  echo     Passe le bon dossier en argument, ou definis RX_TELECHARGEMENTS.
  echo.
  pause
  exit /b 1
)

rem La plus RECENTE : /o-d trie par date decroissante, on garde la premiere.
set "RECETTE="
for /f "delims=" %%F in ('dir /b /a-d /o-d "%DOSSIER%\*.rxrecette.json" 2^>nul') do (
  if not defined RECETTE set "RECETTE=%DOSSIER%\%%F"
)

if not defined RECETTE (
  echo.
  echo   X Aucune recette dans %DOSSIER%
  echo.
  echo     Sur le site : Analyse des departs, marque le depart ^(D^) et le
  echo     premier virage ^(V^) sur la retransmission YouTube, puis clique
  echo     "Preparer l'extrait".
  echo.
  pause
  exit /b 1
)

echo.
echo   Recette : %RECETTE%
echo.

rem %~dp0 = le dossier de CE fichier, donc tools\extract-manche\ : le depot est
rem deux niveaux au-dessus. Aucun chemin en dur, le raccourci suit le depot.
pushd "%~dp0..\.."
node "tools\extract-manche\extract.mjs" --recette "%RECETTE%"
set "CODE=%ERRORLEVEL%"
popd

if "%CODE%"=="0" (
  rem Recette consommee : rangee pour ne pas etre reprise au prochain
  rem double-clic. On ne la SUPPRIME pas : elle dit ce qui a ete extrait, et
  rem elle permet de refaire l'extrait a l'identique.
  if not exist "%DOSSIER%\recettes-faites" mkdir "%DOSSIER%\recettes-faites"
  move /y "%RECETTE%" "%DOSSIER%\recettes-faites\" >nul
  echo.
  echo   Termine. La recette a ete rangee dans recettes-faites\
)

echo.
pause
exit /b %CODE%

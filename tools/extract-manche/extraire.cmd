@echo off
rem ═══════════════════════════════════════════════
rem  EXTRAIRE.CMD — lanceur Windows de l'extraction de manche
rem
rem  Evite d'avoir a taper « node ... » : on peut appeler ce fichier depuis
rem  n'importe quel dossier, ou le glisser dans un raccourci.
rem
rem  Exemple :
rem    tools\extract-manche\extraire.cmd --url https://youtu.be/_SqxZQl5zzQ ^
rem       --start 05:42:26 --fin 05:43:10 ^
rem       --lieu Kerlabo --annee 2026 --categorie D3 --type MQ --num 3 --serie 4
rem ═══════════════════════════════════════════════
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   X Node.js est introuvable dans le PATH.
  echo     Installe-le : winget install OpenJS.NodeJS.LTS
  echo.
  exit /b 1
)
node "%~dp0extract.mjs" %*
exit /b %errorlevel%

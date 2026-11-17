@echo off
rem Harnes installieren: Abhängigkeiten holen, bauen und den Befehl "harnes" einrichten.
rem Danach reicht in jedem Terminal: harnes
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js fehlt. Bitte zuerst von https://nodejs.org installieren. & exit /b 1)
echo [1/3] Abhaengigkeiten holen ...
call npm install --no-audit --no-fund || exit /b 1
echo [2/3] Befehl "harnes" einrichten ...
call npm link || exit /b 1
rem PowerShell nimmt sonst die .ps1-Starter, die bei gesperrten Skripten nicht laufen
for %%n in (harnes harnes-browser rh remoteharnes harnesremote) do del /q "%APPDATA%\npm\%%n.ps1" 2>nul
echo [3/3] Begleiter bauen (nur wenn Rust installiert ist) ...
where cargo >nul 2>nul && (pushd begleiter & cargo build --release & popd) || echo Rust fehlt - Begleiter wird uebersprungen.
echo.
echo Fertig. In einem neuen Terminal einfach "harnes" eingeben.
endlocal

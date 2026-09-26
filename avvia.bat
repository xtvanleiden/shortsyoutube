@echo off
rem Doppio clic per avviare Shorts Studio.
cd /d "%~dp0"

if not exist venv\Scripts\python.exe (
  echo Creo l'ambiente Python, solo la prima volta...
  python -m venv venv || goto :errore
)

echo Controllo le librerie...
venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements.txt || goto :errore

venv\Scripts\python.exe app.py
pause
exit /b

:errore
echo.
echo Qualcosa e' andato storto. Controlla di avere Python 3.11+ installato.
pause

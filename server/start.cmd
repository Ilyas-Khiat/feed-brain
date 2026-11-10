@echo off
rem Starts the Feed Brain server. Keep this window open while you use the extension.
cd /d "%~dp0"
if not exist "config.json" (
  copy /y config.example.json config.json >nul
  echo First run on this computer: created server\config.json.
  echo Set "vault_path" to the folder for your vault, save, then run start.cmd again.
  notepad config.json
  pause
  exit /b
)
if not exist ".venv\Scripts\python.exe" (
  echo First run: creating the Python environment...
  python -m venv .venv || goto :error
)
rem Re-run on every start so new requirements arrive with a git pull (fast when nothing changed).
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || goto :error
".venv\Scripts\python.exe" brain_server.py
pause
exit /b
:error
echo Setup failed. Check that Python 3.10+ is installed and on PATH.
pause

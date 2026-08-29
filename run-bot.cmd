@echo off
REM Start the Discord tickets bot on Windows.
REM The original deploy/heimdall-bot.service is a Linux systemd unit and
REM does not apply here. Run this from a terminal, or wrap it with NSSM or
REM Task Scheduler once it is proven working.
cd /d "%~dp0"
set HEIMDALL_ENV_FILE=%~dp0.env
node src\index.js

@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js 18 or newer from https://nodejs.org & pause & exit /b 1)
node setup-sms.js
pause

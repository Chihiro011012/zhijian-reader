@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo 首次使用请先在本目录运行 npm install 和 npm run build。
  pause
  exit /b 1
)
node scripts\serve.mjs
pause

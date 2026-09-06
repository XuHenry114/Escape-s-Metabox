@echo off
rem 一键启动本地服务器并打开游戏
cd /d %~dp0
where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000/index.html
  python -m http.server 8000
  goto :eof
)
where npx >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8000/index.html
  npx -y serve -l 8000 .
  goto :eof
)
echo 未找到 python 或 npx，请手动用任意静态服务器打开 index.html
pause

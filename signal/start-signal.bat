@echo off
chcp 65001 >nul
rem Comp Check 中継サーバーを起動する(このウィンドウを閉じると止まる)
title Comp Check 中継サーバー
cd /d "%~dp0"

rem すでに起動していれば二重に起動しない
curl -s -m 2 http://127.0.0.1:8790/health >nul 2>&1
if %errorlevel%==0 (
  echo 中継サーバーはすでに起動しています。
  timeout /t 3 >nul
  exit /b
)

rem tailnet への公開(設定済みなら何も変わらない)
"C:\Program Files\Tailscale\tailscale.exe" serve --bg 8790 >nul 2>&1

echo ============================================
echo  Comp Check 中継サーバー
echo  このウィンドウを閉じると止まります
echo ============================================
"C:\Program Files\Tailscale\tailscale.exe" serve status
echo.
rem 隣に yt-cut-analyzer があれば、そのインストールページも /ytcut/ で配る
set STATIC=
if exist "%~dp0..\..\yt-cut-analyzer\dist\install.html" set STATIC=--static "/ytcut=%~dp0..\..\yt-cut-analyzer\dist"
node server.js 8790 %STATIC%
echo.
echo 中継サーバーが止まりました。
pause

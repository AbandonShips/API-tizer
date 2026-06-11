@echo off
chcp 65001 >nul
title API-Tizer 로컬 서버
cd /d "%~dp0"
echo.
echo  API-Tizer 서버를 시작합니다...  브라우저에서 http://localhost:8753 접속
echo  (종료하려면 이 창에서 Ctrl+C)
echo.
start "" "http://localhost:8753"
where py >nul 2>nul && (py server.py & goto :eof)
python server.py

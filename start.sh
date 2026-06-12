#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

echo
echo " API-Tizer 로컬 개발 서버를 시작합니다."
echo " 브라우저에서 http://localhost:8753 접속"
echo " 배포/모바일 실사용은 https://abandonships.github.io/API-tizer/ 권장"
echo " 종료하려면 이 터미널에서 Ctrl+C"
echo

if command -v python3 >/dev/null 2>&1 && python3 -V >/dev/null 2>&1; then
  python3 server.py
elif command -v python >/dev/null 2>&1 && python -V >/dev/null 2>&1; then
  python server.py
else
  echo "Python 실행 파일을 찾지 못했습니다. python3 또는 python을 설치해 주세요."
  exit 1
fi

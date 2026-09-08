#!/usr/bin/env bash
# Деплой на mts.my-site.space: локальная сборка → rsync dist и docker-файлов → пересборка сервиса в docker compose.
set -euo pipefail
HOST=${HOST:-root@165.227.157.219}
REMOTE_DIR=/srv/app/mts
cd "$(dirname "$0")/.."

npm run build
rsync -az --delete -e "ssh -i ~/.ssh/id_ed25519" dist/ "$HOST:$REMOTE_DIR/dist/"
rsync -az -e "ssh -i ~/.ssh/id_ed25519" deploy/Dockerfile deploy/nginx.conf "$HOST:$REMOTE_DIR/"
ssh -i ~/.ssh/id_ed25519 "$HOST" 'cd /srv/app && docker compose up -d --build mts && docker image prune -f >/dev/null'
echo "deployed: https://mts.my-site.space"

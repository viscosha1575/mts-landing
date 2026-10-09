#!/usr/bin/env bash
# Деплой: исходники уезжают на сервер, образ фронта собирается там с нуля (без кеша слоёв и со свежими
# базовыми образами), затем docker compose поднимает Traefik и фронт.
# Нужны: вход на сервер по ключу, Docker с плагином compose и файл .env в каталоге проекта на сервере.
set -euo pipefail
HOST=${HOST:-root@178.250.159.72}
REMOTE_DIR=${REMOTE_DIR:-/opt/mts-scroll}
cd "$(dirname "$0")/.."

ssh "$HOST" "mkdir -p '$REMOTE_DIR'"
# .env на сервере свой — не трогаем; исходники картинок и локальные сборки на сервере не нужны
rsync -az --delete \
  --exclude .git --exclude .claude --exclude .env --exclude .DS_Store --exclude '*.pdf' \
  --exclude node_modules --exclude dist --exclude .astro \
  --exclude frontend/assets-src \
  ./ "$HOST:$REMOTE_DIR/"

ssh "$HOST" "cd '$REMOTE_DIR' \
  && { test -f .env || { echo 'на сервере нет .env — скопируйте .env.example и задайте DOMAIN'; exit 1; }; } \
  && docker compose build --no-cache --pull \
  && docker compose up -d --remove-orphans \
  && docker image prune -f >/dev/null \
  && docker compose ps"
echo "deployed: https://$(ssh "$HOST" "sed -n 's/^DOMAIN=//p' '$REMOTE_DIR/.env'")"

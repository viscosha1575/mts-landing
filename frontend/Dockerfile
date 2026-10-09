# Продакшен-образ фронта. Сборка Astro идёт внутри образа — с чистого листа, из package-lock.json,
# без локального dist и node_modules; в итоговый образ попадает только статика за nginx.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY astro.config.mjs tsconfig.json ./
COPY public ./public
COPY src ./src
# адрес сайта (canonical и абсолютные ссылки) — из docker-compose.yml
ARG SITE_URL
ENV SITE_URL=$SITE_URL ASTRO_TELEMETRY_DISABLED=1
RUN npm run build

FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1
CMD ["nginx", "-g", "daemon off;"]

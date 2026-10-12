# Альтернатива установке на «голый» сервер — контейнер (см. deploy/README.md).
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8792 \
    DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8792/healthz >/dev/null || exit 1
CMD ["node", "server.js"]

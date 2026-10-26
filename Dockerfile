# syntax=docker/dockerfile:1
# Debian-based (glibc) image: Node's built-in sqlite is guaranteed there. No npm install step: zero dependencies.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY system ./system

# /data holds the database and uploads. A named volume inherits this ownership on first use.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

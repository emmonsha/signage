# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/storage

# ffmpeg — конвертация видео; шрифты нужны для PDF: страницы со стандартными (невстроенными) шрифтами иначе рисуются без текста
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /storage && chown node:node /storage

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# --chmod: при строгом umask на хосте (027/077) файлы приходят как 600/700, и
# непривилегированный пользователь node их не прочитает. Задаём права при копировании.
COPY --chmod=0755 server.js processor.js video.js auth.js netguard.js freeipa.js snapshot.js \
     deploy.js hash-password.js screens.js session-store.js users.js ./
COPY --chmod=0755 public ./public

USER node
VOLUME /storage
EXPOSE 3000

# в slim-образе нет curl, поэтому проверка через встроенный fetch Node 22
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

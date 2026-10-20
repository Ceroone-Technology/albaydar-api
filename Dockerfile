# ── Imagen de la API de Albaydar ─────────────────────────────────────────────
# Multietapa: compila TypeScript y deja una imagen final solo con lo necesario.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOADS_DIR=/app/storage/uploads
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/albaydar-entrypoint
RUN chmod +x /usr/local/bin/albaydar-entrypoint && mkdir -p /app/storage/uploads && chown -R node:node /app/storage
# Arranca como root solo para ajustar los permisos de la carpeta de ficheros
# (montada desde tu equipo); el servidor pasa enseguida al usuario sin privilegios "node".
ENV RUN_AS_USER=node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["albaydar-entrypoint"]
CMD ["node", "dist/server.js"]

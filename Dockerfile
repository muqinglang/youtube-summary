# Build the server bundle with the dev toolchain, then ship a runtime image without it.
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Playwright and the extension toolchain are dev dependencies; the browser binaries are only
# fetched by `playwright install`, which this image never runs.
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY server ./server
COPY src ./src
RUN npm run server:build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist-server ./dist-server

# Runs unprivileged; the image needs no write access to its own files.
USER node
EXPOSE 8787
ENV PORT=8787

# Readiness is checked by the platform against /ready, which also proves the database answers.
# This liveness probe deliberately does not touch the database: restarting cannot fix an
# unreachable one, it only turns a blip into a crash loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.js"]

# Build from the repository root. Base images and the workspace dependency graph are pinned.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.34.6 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
ENV CI=true
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS packaged
COPY infra/deployment/stage-runtime.mjs infra/deployment/check-runtime-dependencies.mjs ./infra/deployment/
RUN node infra/deployment/check-runtime-dependencies.mjs && node infra/deployment/stage-runtime.mjs \
 && cd /out && pnpm install --prod --frozen-lockfile --offline --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
ENV NODE_ENV=production APP_ENV=production
WORKDIR /app
COPY --from=packaged --chown=node:node /out /app
USER node
ENTRYPOINT ["node"]

FROM runtime AS api
ENV API_HOST=0.0.0.0 API_PORT=4100
CMD ["apps/api/dist/main.js"]
EXPOSE 4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:4100/readyz',{signal:AbortSignal.timeout(2000)});process.exit(r.ok?0:1)"]

FROM runtime AS worker
CMD ["apps/worker/dist/main.js"]

FROM runtime AS tool-runner
CMD ["apps/tool-runner/dist/main.js"]

FROM caddy:2.11.6-alpine@sha256:c776e0c6413b544d0459665e54ec7b8b2a15000c0cbee8b254da0067b1d184ff AS web
COPY --from=build /workspace/apps/web/dist /srv
COPY infra/deployment/Caddyfile /etc/caddy/Caddyfile

RUN chown -R 1000:1000 /data /config
USER 1000:1000

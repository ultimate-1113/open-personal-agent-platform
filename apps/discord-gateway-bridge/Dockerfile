FROM --platform=$BUILDPLATFORM node:26.13.0-alpine AS build
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/discord-gateway-bridge/package.json apps/discord-gateway-bridge/package.json
COPY packages/discord-connector/package.json packages/discord-connector/package.json
RUN npx --yes pnpm@11.23.0 install --frozen-lockfile --filter @opap/discord-gateway-bridge... --prod=false
COPY apps/discord-gateway-bridge/src apps/discord-gateway-bridge/src
COPY apps/discord-gateway-bridge/tsconfig.json apps/discord-gateway-bridge/tsconfig.json
COPY packages/discord-connector/src packages/discord-connector/src
RUN npx --yes pnpm@11.23.0 --filter @opap/discord-gateway-bridge build

FROM node:26.13.0-alpine
RUN addgroup -S opap && adduser -S -G opap -h /app opap
WORKDIR /app
COPY --from=build --chown=opap:opap /workspace/apps/discord-gateway-bridge/dist ./dist
RUN mkdir /state && chown opap:opap /state
USER opap
ENV NODE_ENV=production \
    DISCORD_BRIDGE_STATE_PATH=/state/session.json \
    DISCORD_BRIDGE_HEALTH_PORT=9464
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

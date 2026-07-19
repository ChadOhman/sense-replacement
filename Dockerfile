# ---- build stage ----
FROM node:24-alpine AS build
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
RUN pnpm -r build
# Produce a pruned production install for the server (keeps compiled better-sqlite3).
# --legacy: pnpm 10+ otherwise requires inject-workspace-packages for deploy.
RUN pnpm --filter @sense/server deploy --legacy --prod /deploy/server

# ---- runtime stage ----
FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build /deploy/server ./packages/server
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
VOLUME /data
EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]

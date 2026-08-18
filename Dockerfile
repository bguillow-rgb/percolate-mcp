# Used by MCP directories (Glama) to run the server for introspection checks.
# Zero-config by design: the catalog is read through a baked publishable (anon)
# key that grants public-read only, under RLS. Supplying SUPABASE_SERVICE_ROLE_KEY
# is optional and unlocks aggregate trending data; nothing here ever writes
# except append-only telemetry.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev
ENTRYPOINT ["node", "dist/index.js"]

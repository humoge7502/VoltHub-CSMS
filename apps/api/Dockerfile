FROM node:22-slim
WORKDIR /srv/volthub
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/ocpp-messages/package.json packages/ocpp-messages/
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund
# B2G-001: worker relay needs pg for the Timescale branch (optionalDep of @volthub/worker).
RUN npm install --no-audit --no-fund --omit=dev pg || npm install --no-audit --no-fund pg
COPY apps/api apps/api
# Worker runs from the same image (compose overrides CMD) — it must be present.
COPY apps/worker apps/worker
COPY packages packages
ENV PORT=4000 SEED_PROFILE=demo
EXPOSE 4000
CMD ["node", "apps/api/src/server.js"]

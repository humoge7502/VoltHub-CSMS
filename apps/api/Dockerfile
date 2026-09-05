FROM node:20-slim
WORKDIR /srv/volthub
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/ocpp-messages/package.json packages/ocpp-messages/
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund
COPY apps/api apps/api
COPY packages packages
ENV PORT=4000 SEED_PROFILE=demo
EXPOSE 4000
CMD ["node", "apps/api/src/server.js"]

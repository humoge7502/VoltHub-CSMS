FROM node:22-slim
WORKDIR /srv/web
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY apps/web ./
# NEXT_PUBLIC_* values are INLINED into the browser bundle at build time (next.config.js
# maps them through `env`), so they must be build args — setting them only in the
# compose `environment:` block has no effect on what the browser downloads. Without
# these, every image shipped pointing at http://localhost:4000 and the documented
# Caddy/TLS deployment (app.example + api.example) could not be built at all.
ARG NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]

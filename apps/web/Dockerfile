FROM node:20-slim
WORKDIR /srv/web
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY apps/web ./
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]

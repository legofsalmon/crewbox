# Live Patch "festival box": one container serving the app, the sync relay,
# and attachment storage. See DEPLOYMENT.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/index.cjs ./
COPY --from=build /app/dist /app/dist
ENV STATIC_DIR=/app/dist \
    DATA_DIR=/data \
    PORT=1234
VOLUME /data
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:1234/healthz || exit 1
CMD ["node", "index.cjs"]

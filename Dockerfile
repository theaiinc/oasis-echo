FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/ packages/

RUN npm ci --ignore-scripts
RUN npx tsc -b --verbose

FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init curl

COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/ packages/
COPY packages/app/src/index.html packages/app/src/index.html

ENV NODE_ENV=production
ENV PORT=9187
ENV OASIS_LOG_LEVEL=info

EXPOSE 9187

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD curl -sf http://127.0.0.1:9187/config > /dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/app/dist/server.js"]

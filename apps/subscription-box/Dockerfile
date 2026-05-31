# Multi-stage build for Subscription Boxes.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/subscription-box ./apps/subscription-box
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/subscription-box
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/subscription-box/package.json ./apps/subscription-box/package.json
COPY --from=builder /work/apps/subscription-box/node_modules ./apps/subscription-box/node_modules
COPY --from=builder /work/apps/subscription-box/dist ./apps/subscription-box/dist
COPY apps/subscription-box/server.js ./apps/subscription-box/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/subscription-box
CMD ["node", "server.js"]

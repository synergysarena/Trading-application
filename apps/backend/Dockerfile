# Multi-stage production build for Node backend
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/

RUN npm install --legacy-peer-deps

COPY packages/shared/ ./packages/shared/
COPY apps/backend/ ./apps/backend/

RUN npm run build:shared
RUN npm run build -w apps/backend

FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/backend/package.json ./apps/backend/

RUN npm install --omit=dev --legacy-peer-deps

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

CMD ["npm", "run", "start", "-w", "apps/backend"]

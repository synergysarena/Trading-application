# Multi-stage production build for React frontend
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/frontend/package.json ./apps/frontend/

RUN npm install --legacy-peer-deps

COPY packages/shared/ ./packages/shared/
COPY apps/frontend/ ./apps/frontend/

RUN npm run build:shared
RUN npm run build -w apps/frontend

FROM nginx:stable-alpine
COPY --from=builder /app/apps/frontend/dist /usr/share/nginx/html
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

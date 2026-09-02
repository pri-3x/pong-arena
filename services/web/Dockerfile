# ---------- STAGE 1: build the static bundle ----------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---------- STAGE 2: serve it ----------
# No Node.js at runtime at all - the output is just HTML/CSS/JS files, so a
# static web server is both smaller and faster than running Vite in production.
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 8080

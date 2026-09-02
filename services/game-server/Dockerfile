# ---------- STAGE 1: build ----------
# We need TypeScript + devDependencies to compile. None of that ships to prod.
FROM node:20-alpine AS builder
WORKDIR /app

# Copy ONLY the manifests first. Docker caches each step; as long as these two
# files don't change, the slow "npm ci" below is reused from cache.
COPY package.json package-lock.json ./
RUN npm ci

# Now copy source. Source changes often, so it goes AFTER the install step.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- STAGE 2: runtime ----------
# A fresh, tiny image. Nothing from stage 1 comes along except what we copy.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only - no typescript, no tsx.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled JavaScript out of the builder stage.
COPY --from=builder /app/dist ./dist

# Do not run as root. If someone escapes the app, they land as an unprivileged user.
USER node

# Documentation for humans; it does NOT publish the port by itself.
EXPOSE 3000

CMD ["node", "dist/index.js"]

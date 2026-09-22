FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# One-shot image that applies the database migrations (`docker-compose.prod.yml` runs it as the
# `migrate` service before the API and worker start). It is built from the builder stage because
# the Prisma CLI is a devDependency and the runtime image below installs production deps only.
FROM builder AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# Runtime image — keep this the LAST stage so a plain `docker build` produces it.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma

EXPOSE 3001
CMD ["node", "dist/main.js"]

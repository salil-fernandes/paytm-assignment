# Build stage
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# Production stage
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Apply OS security patches
RUN apk update && apk upgrade --no-cache

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

# Run as non-root user
USER node

EXPOSE 3000
CMD ["npm", "start"]
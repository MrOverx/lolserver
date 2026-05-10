
# Use official Node.js LTS image (lightweight alpine)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies with clean cache
RUN npm ci --only=production \
  && npm cache clean --force

# Copy application files (but respect .dockerignore)
COPY . .

# Cloud Run environment
ENV PORT=8080
ENV NODE_ENV=production
ENV SERVER_BIND=0.0.0.0

# Expose port
EXPOSE 8080

# Health check (5s timeout, starts after 15s, checks every 10s)
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})" || exit 1

# Start server
CMD ["node", "ws_server.js"]

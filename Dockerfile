
# Use the official Bun image
FROM oven/bun:1

# Set working directory
WORKDIR /app

# Copy package files and node_modules
COPY package.json package-lock.json* bun.lockb* ./
RUN bun install --production || npm install --production

# Copy your entire application
COPY . .

# Cloud Run injects the PORT env variable (default 8080)
ENV PORT=8080
ENV NODE_ENV=production

# Expose the port (documentation only, Cloud Run ignores this but good practice)
EXPOSE 8080

# Health check for Cloud Run
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Start command
CMD ["bun", "ws_server.js"]

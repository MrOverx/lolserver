
# Use the official Bun image
FROM oven/bun:1

# Set working directory
WORKDIR /app

# Copy package files (if you have them, otherwise just copy the js file)
# COPY package.json bun.lockb ./
# RUN bun install --production

# Copy your actual server file
COPY ws_server.js .

# Cloud Run injects the PORT env variable (default 8080)
# Make sure your code uses process.env.PORT || 8080
ENV PORT=8080

# Expose the port (documentation only, Cloud Run ignores this but good practice)
EXPOSE 8080

# Start command
CMD ["bun", "ws_server.js"]

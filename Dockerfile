FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Environment variables
ENV PORT=3000
ENV DB_PATH=/app/data/dashboard.db
ENV SYNC_CRON="0 3 * * *"

# Run the server
CMD ["bun", "run", "backend/index.ts"]

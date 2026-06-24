FROM node:22-alpine

RUN npm install -g @nubjs/nub

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN nub install --frozen-lockfile

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
CMD ["nub", "backend/index.ts"]

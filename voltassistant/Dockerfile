ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and build dependencies
RUN apk add --no-cache nodejs npm python3 make g++ 

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for build)
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce size
RUN npm prune --production

# Cleanup build tools
RUN apk del python3 make g++

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "dist/server.js"]

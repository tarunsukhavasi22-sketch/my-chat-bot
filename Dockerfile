# Red Hat Universal Base Image — compatible with OpenShift / CRC
FROM registry.access.redhat.com/ubi9/nodejs-20:latest

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY server.js ./
COPY public/ ./public/

# OpenShift runs containers as a random non-root UID by default.
# UBI images already handle this, but we explicitly set permissions.
RUN chown -R 1001:0 /app && chmod -R g=u /app
USER 1001

EXPOSE 3000

CMD ["node", "server.js"]

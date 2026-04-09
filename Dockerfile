# Red Hat Universal Base Image — compatible with OpenShift / CRC
FROM registry.access.redhat.com/ubi9/nodejs-20:latest

USER root

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY server.js ./
COPY public/ ./public/

# Set ownership for OpenShift compatibility (random non-root UID)
RUN chown -R 1001:0 /app && chmod -R g=u /app

USER 1001

EXPOSE 3000

CMD ["node", "server.js"]

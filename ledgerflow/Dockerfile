# Untested template (no Docker daemon was available while building). Review before use.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0 PORT=3000 DATABASE_FILE=/data/ledgerflow.db BACKUP_DIR=/data/backups
VOLUME /data
EXPOSE 3000
USER node
CMD ["npm", "start"]

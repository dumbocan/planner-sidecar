FROM node:22.22.3-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY README.md ./README.md
USER node
CMD ["node", "src/server.js"]

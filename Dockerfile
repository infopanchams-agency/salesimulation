FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN node scripts/check.js
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]

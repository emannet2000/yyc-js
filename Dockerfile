FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ server/
COPY shared/ shared/
COPY --from=builder /app/public/ public/
RUN mkdir -p data
VOLUME ["/app/data"]
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
CMD ["node", "server/start.js"]

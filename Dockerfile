FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# 只 COPY 运行必需的，禁止 `COPY . .`
COPY package.json gateway.mjs ./
COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3051
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3051/health || exit 1
CMD ["node", "gateway.mjs"]

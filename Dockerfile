# 基础镜像可注入 digest（CI 里 `docker buildx imagetools inspect node:22-alpine` 解析后
# 通过 --build-arg BASE_IMAGE=node:22-alpine@sha256:… 传入）；本地缺省仍是 tag，直接可构建。
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
# OCI 溯源标签：CI 构建时传 --build-arg REVISION=$(git rev-parse HEAD)
ARG REVISION=unknown
LABEL org.opencontainers.image.revision="${REVISION}"
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

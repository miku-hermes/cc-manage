# 基础镜像可注入 digest（CI 里解析后传 --build-arg BASE_IMAGE=node:22-alpine@sha256:…），
# 本地缺省用 tag 以便直接构建。
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}
WORKDIR /app
# OCI 溯源标签：CI 构建时传 --build-arg REVISION=$(git rev-parse HEAD)
ARG REVISION=unknown
LABEL org.opencontainers.image.revision="${REVISION}"
COPY package.json proxy.mjs ./
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --spider http://127.0.0.1:3050/health || exit 1
CMD ["node", "proxy.mjs"]

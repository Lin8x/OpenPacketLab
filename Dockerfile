# syntax=docker/dockerfile:1
# OpenPacketLab web build, served as static files.
# Multi-arch: linux/amd64, linux/arm64, linux/arm/v7, linux/ppc64le, linux/s390x, linux/riscv64.

FROM --platform=$BUILDPLATFORM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine
LABEL org.opencontainers.image.title="OpenPacketLab" \
      org.opencontainers.image.description="Open-source network simulator and teaching lab. No account required." \
      org.opencontainers.image.source="https://github.com/Lin8x/OpenPacketLab" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

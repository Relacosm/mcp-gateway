# Build from the repo root (it bundles the Helm chart):
#   docker build -f services/provisioner/Dockerfile -t urumi/provisioner:0.1.0 .
FROM node:22-alpine AS build
WORKDIR /app
COPY services/provisioner/package*.json ./
RUN npm ci
COPY services/provisioner/tsconfig.json ./
COPY services/provisioner/src ./src
RUN npm run build && npm prune --omit=dev

FROM alpine:3.20 AS tools
ARG TARGETARCH=amd64
ARG HELM_VERSION=v3.16.4
ARG KUBECTL_VERSION=v1.31.4
RUN apk add --no-cache curl tar \
 && curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" | tar -xz -C /tmp \
 && install -m 0755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
 && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
 && chmod 0755 /usr/local/bin/kubectl

FROM node:22-alpine
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=tools /usr/local/bin/helm /usr/local/bin/kubectl /usr/local/bin/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY services/provisioner/package.json ./
# The same chart the platform was installed from, so every store matches it.
COPY charts/platform /charts/platform
USER 1000
EXPOSE 3000
CMD ["node", "dist/index.js"]

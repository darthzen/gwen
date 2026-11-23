# Gwen. Built in-cluster by kaniko from the public repo; see README.md.
# Base image policy: SUSE BCI.
FROM registry.suse.com/bci/nodejs:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM registry.suse.com/bci/nodejs:22
WORKDIR /app
ENV NODE_ENV=production \
    GWEN_DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Numeric so Kubernetes can verify runAsNonRoot.
USER 1000:1000
CMD ["node", "dist/main.js"]

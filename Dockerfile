FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.19.0 && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node . .
ENV NODE_ENV=production
USER node
CMD ["node", "server.cjs"]

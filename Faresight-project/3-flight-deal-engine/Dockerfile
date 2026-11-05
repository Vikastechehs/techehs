# Flight deal engine: scanner, deal engine, website and user API in one process.
# Node 22.18+ runs the TypeScript sources directly, so there is no build step.
FROM node:22-alpine

ENV NODE_ENV=production PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY tsconfig.json .env.example ./

# Run as the unprivileged "node" user. data/ holds the built-in database when DATABASE_URL is empty
# (mount a volume there to keep it); with DATABASE_URL set it stays unused.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/main.ts"]

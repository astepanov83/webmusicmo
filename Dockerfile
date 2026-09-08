FROM node:22-alpine

WORKDIR /app
COPY package.json server.js docker-entrypoint.sh ./
COPY lib ./lib
COPY scripts ./scripts
COPY stations ./stations
COPY public ./public
RUN chmod +x docker-entrypoint.sh \
 && (node scripts/refresh.js || echo "refresh failed at build, shipping the committed list")

ENV HOST=0.0.0.0
ENV PORT=8420
EXPOSE 8420

ENTRYPOINT ["./docker-entrypoint.sh"]

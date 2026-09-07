FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV HOST=0.0.0.0
ENV PORT=8420
EXPOSE 8420

CMD ["node", "server.js"]

FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000
VOLUME /app/storage
EXPOSE 3000
USER node
CMD ["node", "server.js"]

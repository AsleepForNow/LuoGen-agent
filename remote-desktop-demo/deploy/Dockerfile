FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./server.js
COPY public ./public
USER node
EXPOSE 3000
CMD ["node","server.js"]

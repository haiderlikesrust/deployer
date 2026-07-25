FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=4567
EXPOSE 4567
CMD ["node", "server.js"]

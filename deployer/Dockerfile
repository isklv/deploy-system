FROM node:22-alpine

# Install docker CLI for compose
RUN apk add --no-cache docker-cli git openssh-client

WORKDIR /app
COPY server.js package.json ./
RUN npm install --production

EXPOSE 9090
CMD ["node", "server.js"]

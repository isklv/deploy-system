FROM node:22-alpine

# Install docker CLI + docker-compose standalone
RUN apk add --no-cache docker-cli git openssh-client wget ca-certificates \
    && wget -qO /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/download/v2.32.1/docker-compose-linux-x86_64" \
    && chmod +x /usr/local/bin/docker-compose

WORKDIR /app
COPY server.js package.json ./
RUN npm install --production

EXPOSE 9090
CMD ["node", "server.js"]

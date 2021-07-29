FROM node:16-alpine3.14

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package.json ./
COPY package-lock.json ./

RUN npm ci --only=production

COPY --chown=node:node . .

EXPOSE 18545
EXPOSE 9090
USER node

CMD [ "npm", "run", "start"]

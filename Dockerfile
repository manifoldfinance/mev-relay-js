# syntax=docker/dockerfile:1
FROM node:14.17.3-alpine3.14

WORKDIR /usr/src/app

ENV NODE_ENV=production
COPY package.json ./
COPY package-lock.json ./

RUN npm ci --only-production

COPY . .

EXPOSE 18545
EXPOSE 9090

CMD [ "npm", "run", "start"]

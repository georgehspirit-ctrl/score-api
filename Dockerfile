FROM node:22-alpine

RUN apk update && apk upgrade && \
    apk add --no-cache bash git openssh

WORKDIR /app

COPY package.json ./
COPY yarn.lock ./

RUN yarn install --frozen-lockfile

COPY . .

# Upstream's image is a development one — it ends at `yarn dev`, which runs the
# whole vendored strategy tree through ts-node and never binds in time on a
# deploy. Build once here and run the compiled output instead.
RUN yarn build

EXPOSE 3003

CMD ["node", "build/src/index.js"]

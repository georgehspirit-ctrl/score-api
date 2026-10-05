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

# Gate the deploy on the LP strategy's unit tests. They are fully mocked and
# deterministic (no network, no env), so a failure here is a real regression, not
# flake — and a failed build leaves the previous deploy serving. This is where the
# project's "tests run in the build, not on a laptop and not in Actions" rule lives;
# railway.json's buildCommand is ignored because this Dockerfile drives the build.
RUN yarn test:lp

EXPOSE 3003

CMD ["node", "build/src/index.js"]

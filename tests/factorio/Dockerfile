FROM node:22-bookworm AS build

RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter autorio.ts run build
RUN cp packages/autorio/info.json packages/autorio/dist/info.json

FROM debian:bookworm-slim

ARG FACTORIO_VERSION=2.0.77
ENV FACTORIO_VERSION=${FACTORIO_VERSION}
ENV FACTORIO_ROOT=/opt/factorio
ENV TEST_ROOT=/test

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://factorio.com/get-download/${FACTORIO_VERSION}/headless/linux64" -o /tmp/factorio.tar.xz \
  && mkdir -p /opt \
  && tar -xJf /tmp/factorio.tar.xz -C /opt \
  && rm /tmp/factorio.tar.xz

RUN mkdir -p /opt/factorio/mods /test/results /test/saves
COPY --from=build /src/packages/autorio/dist /opt/factorio/mods/autorio_0.1.0
COPY tests/factorio/runner /test/runner
COPY tests/factorio/fixtures /test/fixtures
COPY tests/factorio/run.sh /test/run.sh
RUN chmod +x /test/run.sh

WORKDIR /test
ENTRYPOINT ["/test/run.sh"]

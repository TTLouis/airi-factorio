FROM --platform=linux/amd64 debian:bookworm-slim

ARG AIRI_REPO=TTLouis/airi-factorio
ARG AIRI_SOURCE_REF=feat/npc-transition-work
ARG FACTORIO_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    grep \
    gzip \
    mawk \
    procps \
    tar \
    util-linux \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  if printf '%s' "$AIRI_SOURCE_REF" | grep -Eq '^[a-f0-9]{40}$'; then \
    resolved="$AIRI_SOURCE_REF"; \
  else \
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 60 \
      --proto '=https' --proto-redir '=https' \
      --get --data-urlencode "sha=$AIRI_SOURCE_REF" --data-urlencode 'per_page=1' \
      "https://api.github.com/repos/$AIRI_REPO/commits" \
      --output /tmp/airi-resolution.json; \
    resolved="$(grep -m1 -oE '\"sha\"[[:space:]]*:[[:space:]]*\"[a-f0-9]{40}\"' /tmp/airi-resolution.json | grep -oE '[a-f0-9]{40}' || true)"; \
  fi; \
  printf '%s' "$resolved" | grep -Eq '^[a-f0-9]{40}$'; \
  short="$(printf '%s' "$resolved" | cut -c1-12)"; \
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 \
    --proto '=https' --proto-redir '=https' \
    "https://raw.githubusercontent.com/$AIRI_REPO/$resolved/deploy/pterodactyl/payload-src/installer.sh" \
    --output /tmp/airi-installer.sh; \
  test "$(grep -Ec '^AIRI_REF=\"[a-f0-9]{40}\"$' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -c '^AIRI_REF=' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -Ec '^REVISION=\"[A-Za-z0-9._-]+\"$' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -c '^REVISION=' /tmp/airi-installer.sh)" = 1; \
  awk -v ref="$resolved" -v revision="docker-$short" ' \
    /^AIRI_REF=/ { print "AIRI_REF=\"" ref "\""; next } \
    /^REVISION=/ { print "REVISION=\"" revision "\""; next } \
    { print } \
  ' /tmp/airi-installer.sh > /tmp/airi-installer-patched.sh; \
  AIRI_INSTALL_ROOT=/opt/airi FACTORIO_VERSION="$FACTORIO_VERSION" bash /tmp/airi-installer-patched.sh; \
  printf '%s\n' "$resolved" > /opt/airi/SOURCE_SHA; \
  printf '%s\n' "$AIRI_SOURCE_REF" > /opt/airi/SOURCE_REF; \
  printf '%s\n' "$FACTORIO_VERSION" > /opt/airi/FACTORIO_VERSION_REQUEST; \
  rm -f /tmp/airi-resolution.json /tmp/airi-installer.sh /tmp/airi-installer-patched.sh /opt/airi/airi-config.json

COPY deploy/docker/entrypoint.sh /usr/local/bin/airi-docker-entrypoint
RUN chmod 755 /usr/local/bin/airi-docker-entrypoint

ENV CONTAINER_ROOT=/data
WORKDIR /data
VOLUME ["/data"]
EXPOSE 34197/udp
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/airi-docker-entrypoint"]

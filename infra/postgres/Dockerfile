FROM pgvector/pgvector:0.8.5-pg18-trixie

ARG PG_TEXTSEARCH_VERSION=1.3.1
ARG POSTGRES_MAJOR=18
ARG TARGETARCH

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) package_arch="amd64"; package_sha256="9f256dc7f082235d8fead7df361427e0a0344a9ee64662f3b50449eeb90bbc7c" ;; \
      arm64) package_arch="arm64"; package_sha256="62b6351a320c82dcf802d15704b6c282f2eb03df29ed9906d5c56fafc6c21b83" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install --yes --no-install-recommends ca-certificates curl unzip; \
    archive="pg-textsearch-v${PG_TEXTSEARCH_VERSION}-pg${POSTGRES_MAJOR}-${package_arch}.zip"; \
    curl --fail --location --show-error --silent \
      "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/${archive}" \
      --output "/tmp/${archive}"; \
    echo "${package_sha256}  /tmp/${archive}" | sha256sum --check --strict; \
    unzip "/tmp/${archive}" -d /tmp/pg_textsearch; \
    apt-get install --yes --no-install-recommends /tmp/pg_textsearch/*.deb; \
    rm -rf /tmp/pg_textsearch "/tmp/${archive}" /var/lib/apt/lists/*

#!/usr/bin/env sh
set -eu

infrastructure_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_directory="$(dirname "${infrastructure_directory}")"

exec docker compose \
  --project-directory "${project_directory}" \
  --file "${infrastructure_directory}/compose.yml" \
  "$@"

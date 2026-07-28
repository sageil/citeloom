#!/usr/bin/env sh
set -eu

tool_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
project_directory="$(dirname "$(dirname "${tool_directory}")")"

exec docker compose \
  --project-directory "${project_directory}" \
  --file "${tool_directory}/compose.yml" \
  "$@"

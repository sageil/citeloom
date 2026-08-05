#!/usr/bin/env sh
set -eu

infrastructure_directory="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
repository_directory="$(CDPATH= cd -- "${infrastructure_directory}/.." && pwd)"
backup_directory="${1:-backups}"
compose_profile="${CITELOOM_BACKUP_COMPOSE_PROFILE:-}"
database_name="${CITELOOM_BACKUP_DATABASE_NAME:-citeloom}"
database_service="${CITELOOM_BACKUP_DATABASE_SERVICE:-postgres}"
database_user="${CITELOOM_BACKUP_DATABASE_USER:-citeloom}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${backup_directory}/citeloom-${timestamp}.backup"
temporary_path="${backup_path}.tmp.$$"

if [ -e "${backup_path}" ]; then
  echo "Backup already exists: ${backup_path}" >&2
  exit 1
fi

run_compose() {
  if [ -n "${compose_profile}" ]; then
    (
      cd "${repository_directory}"
      docker compose --profile "${compose_profile}" "$@"
    )
    return
  fi
  (
    cd "${repository_directory}"
    docker compose "$@"
  )
}

resolve_source_content_directory() {
  configured_directory="${CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY:-}"
  if [ -z "${configured_directory}" ]; then
    configured_directory="$(
      run_compose config --environment |
        sed -n 's/^CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY=//p' |
        tail -n 1
    )"
  fi
  if [ -z "${configured_directory}" ]; then
    configured_directory="documents/blobs"
  fi
  case "${configured_directory}" in
    /*) source_content_directory="${configured_directory}" ;;
    *) source_content_directory="${repository_directory}/${configured_directory#./}" ;;
  esac
}

require_writers_stopped() {
  running_services="$(run_compose ps --services --status running)"
  for service in ${running_services}; do
    if [ "${service}" = "web" ] || [ "${service}" = "worker" ]; then
      echo "Stop the web and worker services before creating a backup." >&2
      exit 1
    fi
  done
}

cleanup() {
  rm -rf -- "${temporary_path}"
}

resolve_source_content_directory
require_writers_stopped
mkdir -p "${backup_directory}"
mkdir -p "${temporary_path}"
trap cleanup EXIT HUP INT TERM

run_compose exec -T "${database_service}" pg_dump \
  --username "${database_user}" \
  --dbname "${database_name}" \
  --format custom \
  --no-owner > "${temporary_path}/database.dump"

if [ ! -s "${temporary_path}/database.dump" ]; then
  echo "Database backup is empty." >&2
  exit 1
fi

printf '%s\n' "citeloom-backup-v1" > "${temporary_path}/format"
if [ -d "${source_content_directory}" ]; then
  tar -cf "${temporary_path}/source-content.tar" \
    -C "${source_content_directory}" .
else
  mkdir "${temporary_path}/empty-source-content"
  tar -cf "${temporary_path}/source-content.tar" \
    -C "${temporary_path}/empty-source-content" .
  rmdir "${temporary_path}/empty-source-content"
fi

mv "${temporary_path}" "${backup_path}"
trap - EXIT HUP INT TERM

echo "Created ${backup_path}"

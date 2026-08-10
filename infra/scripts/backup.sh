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
    if [ "${service}" = "migrate" ] \
      || [ "${service}" = "web" ] \
      || [ "${service}" = "worker" ]; then
      echo "Stop the migrate, web, and worker services before creating a backup." >&2
      exit 1
    fi
  done
}

read_source_content_backend() {
  source_content_backend="$(
    run_compose exec -T "${database_service}" psql \
      --username "${database_user}" \
      --dbname "${database_name}" \
      --tuples-only \
      --no-align \
      --command "SELECT COALESCE(settings #>> '{sourceContent,kind}', 'filesystem') FROM application_settings WHERE id = 'runtime'" \
      | tr -d '[:space:]'
  )"
  case "${source_content_backend}" in
    filesystem|s3) ;;
    *)
      echo "Stored source-content backend is invalid: ${source_content_backend}" >&2
      exit 1
      ;;
  esac
}

cleanup() {
  rm -rf -- "${temporary_path}"
}

require_writers_stopped
read_source_content_backend
if [ "${source_content_backend}" = "filesystem" ]; then
  resolve_source_content_directory
fi
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
if [ "${source_content_backend}" = "s3" ]; then
  source_content_export_directory="${temporary_path}/source-content"
  mkdir "${source_content_export_directory}"
  source_content_export_directory="$(
    CDPATH= cd -- "${source_content_export_directory}" && pwd
  )"
  run_compose run --rm --no-deps \
    --volume "${source_content_export_directory}:/backup" \
    worker node dist/cli/index.js source-content export --directory /backup
  tar -cf "${temporary_path}/source-content.tar" \
    -C "${source_content_export_directory}" .
  rm -rf -- "${source_content_export_directory}"
elif [ -d "${source_content_directory}" ]; then
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

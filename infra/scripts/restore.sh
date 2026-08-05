#!/usr/bin/env sh
set -eu

infrastructure_directory="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
repository_directory="$(CDPATH= cd -- "${infrastructure_directory}/.." && pwd)"
compose_profile="${CITELOOM_BACKUP_COMPOSE_PROFILE:-}"
database_name="${CITELOOM_BACKUP_DATABASE_NAME:-citeloom}"
database_service="${CITELOOM_BACKUP_DATABASE_SERVICE:-postgres}"
database_user="${CITELOOM_BACKUP_DATABASE_USER:-citeloom}"

if [ "${1:-}" != "--confirm" ] || [ -z "${2:-}" ]; then
  echo "Usage: pnpm restore --confirm <backup-directory>" >&2
  exit 2
fi

backup_path="$2"
if [ ! -d "${backup_path}" ]; then
  echo "Backup directory does not exist: ${backup_path}" >&2
  exit 2
fi
if [ "$(cat "${backup_path}/format" 2>/dev/null || true)" != "citeloom-backup-v1" ]; then
  echo "Backup format is invalid: ${backup_path}" >&2
  exit 2
fi
if [ ! -s "${backup_path}/database.dump" ] || [ ! -f "${backup_path}/source-content.tar" ]; then
  echo "Backup is incomplete: ${backup_path}" >&2
  exit 2
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
      echo "Stop the web and worker services before restoring a backup." >&2
      exit 1
    fi
  done
}

validate_archive_paths() {
  tar -tf "${backup_path}/source-content.tar" | while IFS= read -r entry; do
    case "${entry}" in
      /*|../*|*/../*|*/..)
        echo "Backup contains an unsafe source content path: ${entry}" >&2
        exit 1
        ;;
    esac
  done
}

resolve_source_content_directory
source_content_parent="$(dirname -- "${source_content_directory}")"
mkdir -p "${source_content_parent}"
source_content_parent="$(CDPATH= cd -- "${source_content_parent}" && pwd)"
source_content_name="$(basename -- "${source_content_directory}")"
if [ "${source_content_name}" = "." ] || [ "${source_content_name}" = "/" ]; then
  echo "Source content restore target is unsafe: ${source_content_directory}" >&2
  exit 2
fi
source_content_directory="${source_content_parent}/${source_content_name}"
working_directory="$(mktemp -d "${source_content_parent}/.citeloom-restore.XXXXXX")"
staged_content="${working_directory}/source-content"
previous_content="${working_directory}/previous-source-content"
rollback_database="${working_directory}/database.dump"

cleanup() {
  rm -rf -- "${working_directory}"
}

trap cleanup EXIT HUP INT TERM

restore_rollback_database() {
  run_compose exec -T "${database_service}" pg_restore \
    --username "${database_user}" \
    --dbname "${database_name}" \
    --clean \
    --if-exists \
    --no-owner < "${rollback_database}"
}

require_writers_stopped
validate_archive_paths
mkdir "${staged_content}"
tar -xf "${backup_path}/source-content.tar" -C "${staged_content}"
if find "${staged_content}" -type l -print -quit | read -r _; then
  echo "Backup source content must not contain symbolic links." >&2
  exit 2
fi

run_compose exec -T "${database_service}" pg_dump \
  --username "${database_user}" \
  --dbname "${database_name}" \
  --format custom \
  --no-owner > "${rollback_database}"
if [ ! -s "${rollback_database}" ]; then
  echo "Could not create the pre-restore database backup." >&2
  exit 1
fi

if ! run_compose exec -T "${database_service}" pg_restore \
  --username "${database_user}" \
  --dbname "${database_name}" \
  --clean \
  --if-exists \
  --no-owner < "${backup_path}/database.dump"; then
  restore_rollback_database
  echo "Restore failed and the previous database was restored." >&2
  exit 1
fi

had_previous_content=false
if [ -e "${source_content_directory}" ]; then
  mv "${source_content_directory}" "${previous_content}"
  had_previous_content=true
fi
if ! mv "${staged_content}" "${source_content_directory}"; then
  if [ "${had_previous_content}" = "true" ]; then
    mv "${previous_content}" "${source_content_directory}"
  fi
  restore_rollback_database
  echo "Source content restore failed and the previous database was restored." >&2
  exit 1
fi

trap - EXIT HUP INT TERM
rm -rf -- "${working_directory}"
echo "Restored ${backup_path}"

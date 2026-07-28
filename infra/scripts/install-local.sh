#!/usr/bin/env bash

set -euo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project_directory=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
compose_command="$project_directory/infra/compose.sh"
environment_example_file="$project_directory/.env.example"
environment_file="$project_directory/.env"
state_directory="$project_directory/data"
state_file="$state_directory/local-install.state"
caddy_root_certificate="$state_directory/caddy/caddy/pki/authorities/local/root.crt"
install_mode=install
reset_database_backup_directory=

print_usage() {
  cat <<'EOF'
Usage: ./infra/scripts/install-local.sh [--check]

Create or reconcile a private local CiteLoom installation.

Options:
  --check  Validate prerequisites, configuration, storage, and installer state
           without changing files or starting services.
  --help   Show this help.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command_name=$1
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "Required command not found: $command_name"
  fi
}

validate_username() {
  local username=$1
  local username_pattern='^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$'
  if [[ ! $username =~ $username_pattern ]]; then
    fail "Administrator username must contain 3 to 100 letters, numbers, dots, underscores, or hyphens, and must start with a letter or number."
  fi
}

measure_bytes() {
  local value=$1
  local byte_count
  byte_count=$(printf '%s' "$value" | wc -c)
  byte_count=${byte_count//[[:space:]]/}
  printf '%s' "$byte_count"
}

is_valid_password() {
  local password=$1
  local byte_count
  local character_count

  if [[ $password == *$'\n'* || $password == *$'\r'* ]]; then
    return 1
  fi
  character_count=${#password}
  byte_count=$(measure_bytes "$password")

  ((character_count >= 15 && character_count <= 1024 && byte_count <= 4096))
}

validate_password() {
  local password=$1
  if ! is_valid_password "$password"; then
    fail "Administrator password must be one line containing 15 to 1,024 characters and no more than 4,096 UTF-8 bytes."
  fi
}

read_secret() {
  prompt=$1
  terminal_settings=$(stty -g)
  trap 'stty "$terminal_settings"' EXIT HUP INT TERM
  printf '%s' "$prompt"
  stty -echo
  IFS= read -r secret_value
  stty "$terminal_settings"
  trap - EXIT HUP INT TERM
  printf '\n'
  REPLY=$secret_value
}

collect_administrator_credentials() {
  administrator_username=${CITELOOM_ADMIN_USERNAME:-}
  administrator_password=${CITELOOM_ADMIN_PASSWORD:-}

  if [ -z "$administrator_username" ] || [ -z "$administrator_password" ]; then
    if [ ! -t 0 ]; then
      fail "Set CITELOOM_ADMIN_USERNAME and CITELOOM_ADMIN_PASSWORD when running the installer without an interactive terminal."
    fi
  fi

  if [ -z "$administrator_username" ]; then
    printf 'Administrator username: '
    IFS= read -r administrator_username
  fi
  validate_username "$administrator_username"

  if [ -z "$administrator_password" ]; then
    read_secret 'Administrator password: '
    administrator_password=$REPLY
    read_secret 'Confirm administrator password: '
    administrator_password_confirmation=$REPLY
    if [ "$administrator_password" != "$administrator_password_confirmation" ]; then
      fail "Administrator passwords do not match."
    fi
    unset administrator_password_confirmation
  fi
  validate_password "$administrator_password"
}

append_administrator_credentials() {
  local temporary_environment_file
  temporary_environment_file=$(mktemp "$environment_file.tmp.XXXXXX")

  if ! cp "$environment_file" "$temporary_environment_file"; then
    rm -f "$temporary_environment_file"
    fail "Unable to prepare the environment configuration."
  fi

  if ! {
    printf '\nCITELOOM_ADMIN_USERNAME='
    encode_dotenv_literal "$administrator_username"
    printf '\nCITELOOM_ADMIN_PASSWORD='
    encode_dotenv_literal "$administrator_password"
    printf '\n'
  } >>"$temporary_environment_file"; then
    rm -f "$temporary_environment_file"
    fail "Unable to write administrator credentials."
  fi

  chmod 600 "$temporary_environment_file"
  if ! mv "$temporary_environment_file" "$environment_file"; then
    rm -f "$temporary_environment_file"
    fail "Unable to replace the environment configuration."
  fi
}

encode_dotenv_literal() {
  local value=$1
  local backslash=$'\\'
  local dollar='$'
  local double_quote='"'
  value=${value//"$backslash"/"$backslash$backslash"}
  value=${value//"$double_quote"/"$backslash$double_quote"}
  value=${value//"$dollar"/"$backslash$dollar"}
  printf '"%s"' "$value"
}

parse_administrator_configuration_status() {
  local line
  local password=
  local username=
  local username_pattern='^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$'

  while IFS= read -r line; do
    case "$line" in
      CITELOOM_ADMIN_PASSWORD=*)
        password=${line#CITELOOM_ADMIN_PASSWORD=}
        ;;
      CITELOOM_ADMIN_USERNAME=*)
        username=${line#CITELOOM_ADMIN_USERNAME=}
        ;;
    esac
  done

  if [[ -z $username && -z $password ]]; then
    printf 'missing'
    return
  fi
  if [[ -z $username || -z $password ]]; then
    printf 'incomplete'
    return
  fi
  if [[ $username =~ $username_pattern ]] && is_valid_password "$password"; then
    printf 'valid'
  else
    printf 'invalid'
  fi
}

read_compose_environment_value() {
  local requested_key=$1
  local line
  local value=
  local value_found=false

  while IFS= read -r line; do
    case "$line" in
      "$requested_key="*)
        value=${line#*=}
        value_found=true
        ;;
    esac
  done

  if [[ $value_found != true ]]; then
    return 1
  fi
  printf '%s' "$value"
}

read_administrator_configuration_status() {
  if ! "$compose_command" --profile https --profile worker config --quiet; then
    fail "Compose configuration is invalid."
  fi

  if ! administrator_configuration_status=$(
    (
      unset CITELOOM_ADMIN_PASSWORD
      unset CITELOOM_ADMIN_USERNAME
      "$compose_command" --profile https --profile worker config --environment
    ) | parse_administrator_configuration_status
  ); then
    fail "Compose configuration is invalid."
  fi
}

read_compose_configuration() {
  local effective_compose_environment
  local effective_database_directory
  local effective_source_content_directory

  if ! effective_compose_environment=$(
    "$compose_command" --profile https --profile worker config --environment
  ); then
    fail "Unable to read the effective Compose environment."
  fi

  if ! effective_administrator_configuration_status=$(
    parse_administrator_configuration_status <<<"$effective_compose_environment"
  ); then
    fail "Unable to validate the effective administrator configuration."
  fi

  case "$effective_administrator_configuration_status" in
    valid)
      ;;
    missing)
      fail "Administrator credentials are missing from the effective Compose environment."
      ;;
    incomplete)
      fail "The effective Compose environment must define both administrator credentials."
      ;;
    invalid)
      fail "Administrator credentials in the effective Compose environment are invalid."
      ;;
    *)
      fail "Unable to validate the effective administrator configuration."
      ;;
  esac

  if ! effective_database_directory=$(
    read_compose_environment_value CITELOOM_POSTGRES_DATA_DIRECTORY \
      <<<"$effective_compose_environment"
  ); then
    effective_database_directory=./data/citeloomdb
  fi
  if [[ -z $effective_database_directory ]]; then
    effective_database_directory=./data/citeloomdb
  fi

  case "$effective_database_directory" in
    /*)
      database_directory=$effective_database_directory
      ;;
    *)
      while [[ $effective_database_directory == ./* ]]; do
        effective_database_directory=${effective_database_directory#./}
      done
      database_directory="$project_directory/$effective_database_directory"
      ;;
  esac

  if ! effective_source_content_directory=$(
    read_compose_environment_value CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY \
      <<<"$effective_compose_environment"
  ); then
    effective_source_content_directory=./documents/blobs
  fi
  if [[ -z $effective_source_content_directory ]]; then
    effective_source_content_directory=./documents/blobs
  fi

  case "$effective_source_content_directory" in
    /*)
      source_content_directory=$effective_source_content_directory
      ;;
    *)
      while [[ $effective_source_content_directory == ./* ]]; do
        effective_source_content_directory=${effective_source_content_directory#./}
      done
      source_content_directory="$project_directory/$effective_source_content_directory"
      ;;
  esac
}

validate_resolved_compose_configuration() {
  export CITELOOM_POSTGRES_DATA_DIRECTORY="$database_directory"
  export CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY="$source_content_directory"
  if ! "$compose_command" --profile https --profile worker config --quiet; then
    fail "Compose configuration is invalid after resolving persistent storage directories."
  fi
}

reject_unsafe_database_directory() {
  candidate_directory=$1
  user_home_directory=${HOME:-}

  case "$candidate_directory" in
    /*) ;;
    *) fail "The resolved PostgreSQL data directory is not absolute: $candidate_directory" ;;
  esac

  case "$candidate_directory" in
    *'
'*) fail "The PostgreSQL data directory must not contain a newline." ;;
  esac
  case "$candidate_directory/" in
    */../*) fail "The PostgreSQL data directory must not contain a parent-directory segment." ;;
  esac

  if [ "$candidate_directory" = "/" ] ||
    [ "$candidate_directory" = "$project_directory" ] ||
    [ "$candidate_directory" = "$state_directory" ]; then
    fail "Refusing unsafe PostgreSQL data directory: $candidate_directory"
  fi

  case "$project_directory/" in
    "$candidate_directory/"*) fail "The PostgreSQL data directory must not contain the repository." ;;
  esac

  if [ -n "$user_home_directory" ]; then
    if [ "$candidate_directory" = "$user_home_directory" ]; then
      fail "The PostgreSQL data directory must not be the user home directory."
    fi
    case "$user_home_directory/" in
      "$candidate_directory/"*) fail "The PostgreSQL data directory must not contain the user home directory." ;;
    esac
  fi

  case "$candidate_directory/" in
    "$project_directory/"*)
      case "$candidate_directory/" in
        "$state_directory/"*) ;;
        *) fail "A PostgreSQL data directory inside the repository must be under $state_directory." ;;
      esac
      ;;
  esac
}

prepare_database_directory() {
  reject_unsafe_database_directory "$database_directory"

  if [ -e "$database_directory" ] && [ ! -d "$database_directory" ]; then
    fail "The PostgreSQL data path exists but is not a directory: $database_directory"
  fi

  if [ "$install_mode" = install ]; then
    mkdir -p "$database_directory"
    database_directory=$(CDPATH='' cd -- "$database_directory" && pwd -P)
    reject_unsafe_database_directory "$database_directory"
  elif [ -d "$database_directory" ]; then
    database_directory=$(CDPATH='' cd -- "$database_directory" && pwd -P)
    reject_unsafe_database_directory "$database_directory"
  fi
}

reject_unsafe_source_content_directory() {
  local candidate_directory=$1
  local user_home_directory=${HOME:-}

  case "$candidate_directory" in
    /*) ;;
    *) fail "The resolved source content directory is not absolute: $candidate_directory" ;;
  esac

  case "$candidate_directory" in
    *'
'*) fail "The source content directory must not contain a newline." ;;
  esac
  case "$candidate_directory/" in
    */../*) fail "The source content directory must not contain a parent-directory segment." ;;
  esac

  if [ "$candidate_directory" = "/" ] ||
    [ "$candidate_directory" = "$project_directory" ] ||
    [ "$candidate_directory" = "$state_directory" ]; then
    fail "Refusing unsafe source content directory: $candidate_directory"
  fi

  case "$project_directory/" in
    "$candidate_directory/"*) fail "The source content directory must not contain the repository." ;;
  esac

  if [ -n "$user_home_directory" ]; then
    if [ "$candidate_directory" = "$user_home_directory" ]; then
      fail "The source content directory must not be the user home directory."
    fi
    case "$user_home_directory/" in
      "$candidate_directory/"*) fail "The source content directory must not contain the user home directory." ;;
    esac
  fi

  case "$candidate_directory/" in
    "$database_directory/"*) fail "The source content directory must not be inside the PostgreSQL data directory." ;;
  esac
  case "$database_directory/" in
    "$candidate_directory/"*) fail "The source content directory must not contain the PostgreSQL data directory." ;;
  esac
}

prepare_source_content_directory() {
  reject_unsafe_source_content_directory "$source_content_directory"

  if [ -e "$source_content_directory" ] &&
    [ ! -d "$source_content_directory" ]; then
    fail "The source content path exists but is not a directory: $source_content_directory"
  fi

  if [ "$install_mode" = install ]; then
    mkdir -p "$source_content_directory"
  elif [ ! -d "$source_content_directory" ]; then
    fail "The source content directory does not exist: $source_content_directory"
  fi

  source_content_directory=$(
    CDPATH='' cd -- "$source_content_directory" && pwd -P
  )
  reject_unsafe_source_content_directory "$source_content_directory"
  if [ ! -w "$source_content_directory" ]; then
    fail "The source content directory is not writable: $source_content_directory"
  fi
}

read_state_value() {
  state_key=$1
  sed -n "s/^${state_key}=//p" "$state_file" | tail -n 1
}

directory_has_entries() {
  [ -n "$(find "$database_directory" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

reset_unrecognized_database_directory() {
  if [ "$install_mode" != install ]; then
    fail "The PostgreSQL data directory is nonempty but is not recognized by this installer: $database_directory"
  fi
  if [ ! -t 0 ]; then
    fail "The PostgreSQL data directory is nonempty and unrecognized. Run the installer interactively to confirm a reset: $database_directory"
  fi

  printf '\nThe PostgreSQL data directory is nonempty and is not recognized by this installer:\n'
  printf '%s\n' "$database_directory"
  printf 'Type RESET to preserve its current contents and initialize a new database: '
  IFS= read -r reset_confirmation
  if [ "$reset_confirmation" != RESET ]; then
    fail "Database directory reset cancelled."
  fi

  if ! "$compose_command" --profile https --profile worker stop \
    web worker migrate postgres; then
    fail "Unable to stop database writers before resetting the PostgreSQL data directory."
  fi

  reset_database_backup_directory="${database_directory}.reset-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if [ -e "$reset_database_backup_directory" ]; then
    fail "Database reset recovery path already exists: $reset_database_backup_directory"
  fi
  if ! mv "$database_directory" "$reset_database_backup_directory"; then
    fail "Unable to preserve the unrecognized PostgreSQL data directory."
  fi
  if ! mkdir -p "$database_directory"; then
    if ! mv "$reset_database_backup_directory" "$database_directory"; then
      fail "Unable to create a new PostgreSQL data directory, and rollback failed. Preserved data remains at: $reset_database_backup_directory"
    fi
    fail "Unable to create a new PostgreSQL data directory."
  fi
  database_directory=$(CDPATH='' cd -- "$database_directory" && pwd -P)
  reject_unsafe_database_directory "$database_directory"
  printf 'Previous PostgreSQL contents preserved at:\n'
  printf '%s\n' "$reset_database_backup_directory"
}

write_install_state() {
  next_state=$1
  mkdir -p "$state_directory"
  if [ -L "$state_file" ]; then
    fail "Refusing installer state file symlink: $state_file"
  fi

  temporary_state_file=$(mktemp "$state_file.tmp.XXXXXX")
  {
    printf 'version=1\n'
    printf 'database_directory=%s\n' "$database_directory"
    printf 'state=%s\n' "$next_state"
  } >"$temporary_state_file"
  mv "$temporary_state_file" "$state_file"
  current_state=$next_state
}

validate_install_state() {
  current_state=unconfigured

  if [ -L "$state_file" ]; then
    fail "Refusing installer state file symlink: $state_file"
  fi

  if [ ! -f "$state_file" ]; then
    if [ -d "$database_directory" ] && directory_has_entries; then
      reset_unrecognized_database_directory
    fi
    if [ "$install_mode" = install ]; then
      write_install_state configured
    fi
    return
  fi

  state_version=$(read_state_value version)
  state_database_directory=$(read_state_value database_directory)
  current_state=$(read_state_value state)

  if [ "$state_version" != "1" ]; then
    fail "Unsupported local installer state version: $state_version"
  fi
  if [ "$state_database_directory" != "$database_directory" ]; then
    fail "The configured PostgreSQL data directory does not match installer state: $state_database_directory"
  fi
  case "$current_state" in
    configured | starting | ready) ;;
    *) fail "Invalid local installer state: $current_state" ;;
  esac

  if [ "$current_state" = ready ] &&
    { [ ! -d "$database_directory" ] || ! directory_has_entries; }; then
    fail "The installer recorded a ready database, but its data directory is now missing or empty."
  fi
}

show_failure_diagnostics() {
  printf '\nCiteLoom did not become ready. Existing data and containers were preserved.\n' >&2
  "$compose_command" --profile https --profile worker ps --all >&2 || true
  "$compose_command" --profile https --profile worker logs --no-color --tail 100 https-proxy migrate web worker >&2 || true
  printf 'Fix the reported problem, then rerun ./infra/scripts/install-local.sh.\n' >&2
}

verify_migration() {
  migration_container=$(
    "$compose_command" --profile https --profile worker ps --all -q migrate
  )
  if [ -z "$migration_container" ]; then
    return 1
  fi

  migration_state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$migration_container")
  [ "$migration_state" = "exited 0" ]
}

verify_service() {
  service_name=$1
  expected_health=$2
  service_container=$(
    "$compose_command" --profile https --profile worker ps -q "$service_name"
  )
  if [ -z "$service_container" ]; then
    return 1
  fi

  service_state=$(docker inspect --format '{{.State.Status}}' "$service_container")
  if [ "$service_state" != "running" ]; then
    return 1
  fi

  if [ "$expected_health" = healthy ]; then
    service_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$service_container")
    [ "$service_health" = healthy ]
  fi
}

verify_services() {
  verify_service postgres healthy &&
    verify_service docling healthy &&
    verify_service hhem healthy &&
    verify_service worker healthy &&
    verify_service web healthy &&
    verify_service https-proxy healthy
}

case ${1:-} in
  "")
    ;;
  --check)
    install_mode=check
    ;;
  --help | -h)
    print_usage
    exit 0
    ;;
  *)
    print_usage >&2
    exit 2
    ;;
esac

if [ "$#" -gt 1 ]; then
  print_usage >&2
  exit 2
fi

require_command curl
require_command docker

if ! docker compose version >/dev/null 2>&1; then
  fail "Docker Compose is unavailable."
fi
if ! docker info >/dev/null 2>&1; then
  fail "The Docker daemon is not running."
fi

environment_created=false
if [ ! -f "$environment_file" ]; then
  if [ "$install_mode" = check ]; then
    fail "Configuration file not found: $environment_file"
  fi
  cp "$environment_example_file" "$environment_file"
  chmod 600 "$environment_file"
  environment_created=true
fi

read_administrator_configuration_status

if [ "$environment_created" = true ] ||
  { [ "$administrator_configuration_status" = missing ] && [ "$install_mode" = install ]; }; then
  collect_administrator_credentials
  append_administrator_credentials
  unset administrator_password
  unset CITELOOM_ADMIN_PASSWORD
  unset CITELOOM_ADMIN_USERNAME
elif [ "$administrator_configuration_status" = incomplete ]; then
  fail "Both CITELOOM_ADMIN_USERNAME and CITELOOM_ADMIN_PASSWORD must be set in .env."
elif [ "$administrator_configuration_status" = invalid ]; then
  fail "Administrator credentials in .env are invalid."
elif [ "$administrator_configuration_status" = missing ]; then
  fail "Administrator credentials are missing from .env."
elif [ "$install_mode" = install ]; then
  chmod 600 "$environment_file"
fi

read_compose_configuration
prepare_database_directory
prepare_source_content_directory
validate_resolved_compose_configuration
validate_install_state

if [ "$install_mode" = check ]; then
  printf 'Local install configuration is valid.\n'
  printf 'PostgreSQL data directory: %s\n' "$database_directory"
  printf 'Source content directory: %s\n' "$source_content_directory"
  printf 'Installer state: %s\n' "$current_state"
  exit 0
fi

mkdir -p "$project_directory/documents/uploads"
write_install_state starting

if ! "$compose_command" --profile https --profile worker stop web worker; then
  show_failure_diagnostics
  exit 1
fi

if ! "$compose_command" --profile https --profile worker up \
  --build \
  --detach \
  --wait \
  --wait-timeout 1800; then
  show_failure_diagnostics
  exit 1
fi

if ! verify_migration || ! verify_services; then
  show_failure_diagnostics
  exit 1
fi

if [ ! -f "$caddy_root_certificate" ]; then
  printf 'Caddy did not create its local root certificate: %s\n' "$caddy_root_certificate" >&2
  show_failure_diagnostics
  exit 1
fi

if ! curl --fail --silent --show-error --insecure --max-time 30 \
  https://localhost:3443/ >/dev/null; then
  show_failure_diagnostics
  exit 1
fi

write_install_state ready

printf '\nCiteLoom is ready.\n'
printf 'Open https://localhost:3443\n'
printf 'PostgreSQL data: %s\n' "$database_directory"
printf 'Source content: %s\n' "$source_content_directory"
if [ -n "$reset_database_backup_directory" ]; then
  printf 'Previous PostgreSQL data: %s\n' "$reset_database_backup_directory"
fi
printf 'If the browser warns about TLS, use its trust or continue flow for this local site.\n'
printf 'Manual certificate import, if required by the browser or operating system: %s\n' "$caddy_root_certificate"

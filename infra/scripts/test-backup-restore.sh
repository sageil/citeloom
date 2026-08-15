#!/usr/bin/env sh
set -eu

infrastructure_directory="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
repository_directory="$(CDPATH= cd -- "${infrastructure_directory}/.." && pwd)"
database_url="postgresql://citeloom:citeloom@127.0.0.1:5433/citeloom_test"
COMPOSE_PROJECT_NAME="citeloom-backup-test"
export COMPOSE_PROJECT_NAME
test_directory="$(mktemp -d "${TMPDIR:-/tmp}/citeloom-backup-restore.XXXXXX")"
backup_directory="${test_directory}/backups"
source_content_directory="${test_directory}/source-content"
source_content="backup source content"
document_id="fd74a46469d95a38532954dfbba42b558649cc8d563f2e6bba431088cded7f4f"
document_byte_length="21"
input_format_id="00000000-0000-4000-8000-000000000001"
content_path="${source_content_directory}/sha256/$(printf '%s' "${document_id}" | cut -c1-2)/${document_id}"
run_id="00000000-0000-4000-8000-000000000099"
retained_space="backup-retained:plain:384"
collected_space="backup-collected:plain:384"

run_compose() {
  (
    cd "${repository_directory}"
    docker compose --profile test "$@"
  )
}

cleanup() {
  rm -rf -- "${test_directory}"
  run_compose exec -T postgres-test psql \
    --username citeloom \
    --dbname citeloom_test \
    --set ON_ERROR_STOP=1 \
    --command "
      DELETE FROM source_content_deletions WHERE document_id = '${document_id}';
      DELETE FROM source_documents WHERE document_id = '${document_id}';
      DELETE FROM embedding_space_gc_runs WHERE id = '${run_id}';
      DELETE FROM embedding_spaces WHERE id = '${retained_space}';
    " >/dev/null 2>&1 || true
  run_compose down --volumes >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

run_compose up -d --wait postgres-test
cd "${repository_directory}"
CITELOOM_ADMIN_PASSWORD="backup restore test password" \
CITELOOM_ADMIN_USERNAME="BackupAdmin" \
DATABASE_URL="${database_url}" \
node --import tsx src/database/migrate.ts

run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --set ON_ERROR_STOP=1 \
  --command "
    DELETE FROM source_content_deletions WHERE document_id = '${document_id}';
    DELETE FROM source_documents WHERE document_id = '${document_id}';
    DELETE FROM embedding_space_gc_runs WHERE id = '${run_id}';
    DELETE FROM embedding_spaces WHERE id = '${retained_space}';
    INSERT INTO source_documents (byte_length, document_id, last_published_at)
    VALUES (${document_byte_length}, '${document_id}', '2026-07-24T12:00:00Z');
    INSERT INTO embedding_spaces (
      id, dimensions, input_format_document_template, input_format_hash,
      input_format_id, input_format_query_template, input_format_schema_version,
      model, profile, created_at, retrieval_window_policy,
      retrieval_window_policy_fingerprint
    )
    SELECT
      '${retained_space}', 384, document_template, input_format_hash, id,
      query_template, schema_version, 'backup-test', name,
      '2026-01-01T00:00:00Z', '{}'::jsonb, repeat('0', 64)
    FROM embedding_input_formats
    WHERE id = '${input_format_id}';
    INSERT INTO embedding_space_gc_runs (
      active_space_id, completed_at, id, mode, retention_cutoff, started_at, status
    ) VALUES (
      '${retained_space}', '2026-07-15T12:00:00Z', '${run_id}', 'apply',
      '2026-06-15T12:00:00Z', '2026-07-15T12:00:00Z', 'completed'
    );
    INSERT INTO embedding_space_gc_spaces (
      completed_at, created_at, dimensions, disposition, estimated_bytes,
      input_format_hash, input_format_name, model, profile, row_counts, run_id,
      space_id, state
    )
    SELECT
      '2026-07-15T12:00:00Z', '2026-01-01T00:00:00Z', 384, 'deletable', 128,
      input_format_hash, name, 'backup-test', name,
      '{\"indexedDocuments\":0,\"lexicalChunks\":1,\"vectorChunks1024\":0,\"vectorChunks384\":1,\"vectorChunks768\":0}',
      '${run_id}', '${collected_space}', 'deleted'
    FROM embedding_input_formats
    WHERE id = '${input_format_id}';
  "

mkdir -p "$(dirname -- "${content_path}")"
printf '%s' "${source_content}" > "${content_path}"

CITELOOM_BACKUP_COMPOSE_PROFILE="test" \
CITELOOM_BACKUP_DATABASE_NAME="citeloom_test" \
CITELOOM_BACKUP_DATABASE_SERVICE="postgres-test" \
CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY="${source_content_directory}" \
"${infrastructure_directory}/scripts/backup.sh" "${backup_directory}"

backup_path="$(find "${backup_directory}" -mindepth 1 -maxdepth 1 -type d -name '*.backup' -print)"
test -d "${backup_path}"
test -s "${backup_path}/database.dump"
test -f "${backup_path}/source-content.tar"

run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --set ON_ERROR_STOP=1 \
  --command "
    DELETE FROM source_documents WHERE document_id = '${document_id}';
    DELETE FROM embedding_space_gc_runs WHERE id = '${run_id}';
    DELETE FROM embedding_spaces WHERE id = '${retained_space}';
  "
printf '%s' "mutated content" > "${content_path}"

CITELOOM_BACKUP_COMPOSE_PROFILE="test" \
CITELOOM_BACKUP_DATABASE_NAME="citeloom_test" \
CITELOOM_BACKUP_DATABASE_SERVICE="postgres-test" \
CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY="${source_content_directory}" \
"${infrastructure_directory}/scripts/restore.sh" --confirm "${backup_path}"

retained_count="$(run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM embedding_spaces WHERE id = '${retained_space}';")"
collected_count="$(run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM embedding_spaces WHERE id = '${collected_space}';")"
audit_count="$(run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM embedding_space_gc_spaces WHERE run_id = '${run_id}' AND space_id = '${collected_space}' AND state = 'deleted';")"
source_count="$(run_compose exec -T postgres-test psql \
  --username citeloom \
  --dbname citeloom_test \
  --tuples-only \
  --no-align \
  --command "SELECT count(*) FROM source_documents WHERE document_id = '${document_id}' AND byte_length = ${document_byte_length};")"

test "${retained_count}" = "1"
test "${collected_count}" = "0"
test "${audit_count}" = "1"
test "${source_count}" = "1"
test "$(cat "${content_path}")" = "${source_content}"

echo "Backup and restore preserved PostgreSQL metadata and source content."

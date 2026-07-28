-- Run from the repository root with:
-- ./infra/compose.sh stop web worker
-- ./infra/compose.sh exec -T postgres psql \
--   -U citeloom \
--   -d postgres \
--   -v reset_citeloom=RESET_CITELOOM \
--   < infra/reset-database.sql
--
-- This permanently deletes the CiteLoom database.
-- It does not delete files under documents/.
-- Run the normal migration container afterward to recreate the baseline.

\set ON_ERROR_STOP on

SELECT current_database() = 'postgres' AS connected_to_maintenance_database
\gset

\if :connected_to_maintenance_database
\else
DO $reset_guard$
BEGIN
  RAISE EXCEPTION 'Connect to the postgres maintenance database before resetting CiteLoom.';
END
$reset_guard$;
\endif

\if :{?reset_citeloom}
SELECT :'reset_citeloom' = 'RESET_CITELOOM' AS reset_confirmed
\gset
\else
\set reset_confirmed false
\endif

\if :reset_confirmed
\else
DO $reset_guard$
BEGIN
  RAISE EXCEPTION 'Refusing to reset CiteLoom without reset_citeloom=RESET_CITELOOM.';
END
$reset_guard$;
\endif

DROP DATABASE IF EXISTS citeloom WITH (FORCE);
CREATE DATABASE citeloom OWNER citeloom;

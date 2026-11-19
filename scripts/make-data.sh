#!/usr/bin/env bash
# Regenerates every dataset the lab benchmarks need. Run from the lab root.
#
# Kept as a script so the multi-GB parquet files never need to live in the
# workspace: `make data` rebuilds them in a couple of minutes.
set -euo pipefail

DUCKDB=${DUCKDB:-/opt/homebrew/bin/duckdb}
EXT_DIR=${EXT_DIR:-/tmp/ddb-ext}
cd "$(dirname "$0")/.."   # lab root, not scripts/

mkdir -p data

echo "==> TPC-H SF1 (6.0M lineitem rows)"
"$DUCKDB" -c "SET extension_directory='$EXT_DIR'; LOAD tpch; CALL dbgen(sf=1);
  COPY lineitem TO 'data/lineitem_sf1.parquet' (FORMAT parquet, COMPRESSION snappy);
  COPY orders   TO 'data/orders_sf1.parquet'   (FORMAT parquet, COMPRESSION snappy);"

echo "==> 16 shards of SF1"
mkdir -p data/shards16
{
  echo "CREATE TEMP TABLE li AS SELECT *, (row_number() OVER () % 16) AS sid FROM read_parquet('data/lineitem_sf1.parquet');"
  for i in $(seq 0 15); do
    echo "COPY (SELECT * EXCLUDE sid FROM li WHERE sid=$i) TO 'data/shards16/part_$i.parquet' (FORMAT parquet, COMPRESSION snappy);"
  done
} | "$DUCKDB"

echo "==> 200k-row CSV sample (used by the browser comparison page)"
"$DUCKDB" -c "COPY (SELECT * FROM read_parquet('data/lineitem_sf1.parquet')
  USING SAMPLE 200000 ROWS (reservoir, 42)) TO 'data/lineitem_200k.csv' (FORMAT csv, HEADER);"

if [[ "${WITH_SF10:-0}" == "1" ]]; then
  echo "==> TPC-H SF10 (60M lineitem rows, ~2 GB) — slow"
  "$DUCKDB" -c "SET extension_directory='$EXT_DIR'; LOAD tpch; CALL dbgen(sf=10);
    COPY lineitem TO 'data/lineitem_sf10.parquet' (FORMAT parquet, COMPRESSION snappy);"
  mkdir -p data/shards_sf10
  {
    echo "CREATE TEMP TABLE li AS SELECT *, (row_number() OVER () % 16) AS sid FROM read_parquet('data/lineitem_sf10.parquet');"
    for i in $(seq 0 15); do
      echo "COPY (SELECT * EXCLUDE sid FROM li WHERE sid=$i) TO 'data/shards_sf10/part_$i.parquet' (FORMAT parquet, COMPRESSION snappy);"
    done
  } | "$DUCKDB"
fi

echo "done."

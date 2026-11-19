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

echo "==> Arena demo tables (5 CSVs the page loads on demand)"
"$DUCKDB" -c "SET extension_directory='$EXT_DIR'; LOAD tpch; CALL dbgen(sf=1);
  COPY (SELECT * FROM orders   USING SAMPLE 20000 ROWS (reservoir, 42)) TO 'data/orders_20k.csv'   (FORMAT csv, HEADER);
  COPY (SELECT * FROM customer USING SAMPLE 20000 ROWS (reservoir, 42)) TO 'data/customer_20k.csv' (FORMAT csv, HEADER);
  COPY nation TO 'data/nation.csv' (FORMAT csv, HEADER);
  COPY region TO 'data/region.csv' (FORMAT csv, HEADER);"
"$DUCKDB" -c "
  COPY (SELECT l.l_orderkey, l.l_linenumber, l.l_quantity, l.l_extendedprice, l.l_discount, l.l_tax,
               l.l_returnflag, l.l_shipdate, l.l_commitdate, l.l_receiptdate, l.l_shipmode
        FROM 'data/lineitem_sf1.parquet' l
        JOIN (SELECT o_orderkey FROM 'data/orders_20k.csv') o ON l.l_orderkey = o.o_orderkey)
    TO 'data/lineitem_20k.csv' (FORMAT csv, HEADER);"

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

/**
 * Parallelism scaling benchmark for duckdb-wasm shard parallelism.
 *
 * Answers one question: on a machine with many cores, does fanning N duckdb-wasm
 * instances across shards beat one instance, and where does it stop paying off?
 *
 * Usage: node bench/scale.mjs [--shards dir] [--runs 3]
 */
import os from 'node:os';
import { Pool, Q1_PARTIAL, Q6_PARTIAL, mergeQ1, mergeQ6, listShards } from './coordinator.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const shardDir = arg('shards', 'data/shards16');
const runs = Number(arg('runs', 3));
const parallelisms = arg('levels', '1,2,4,8,16').split(',').map(Number);
const shards = listShards(shardDir);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`# shard parallelism scaling`);
console.log(`host: ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB`);
console.log(`shards: ${shards.length} files in ${shardDir}`);
console.log('');

const maxP = Math.max(...parallelisms);
const coldStart = performance.now();
const pool = new Pool(maxP);
await pool.start();
const poolInitMs = performance.now() - coldStart;
console.log(`worker pool init (${maxP} instances): ${poolInitMs.toFixed(0)} ms\n`);

const results = [];

for (const p of parallelisms) {
  for (const [queryName, template, merge] of [
    ['q1', Q1_PARTIAL, mergeQ1],
    ['q6', Q6_PARTIAL, mergeQ6],
  ]) {
    // Warm-up: first execution also faults in parquet footers.
    await pool.runSharded(template, shards, p);
    const times = [];
    let rows;
    for (let i = 0; i < runs; i += 1) {
      const r = await pool.runSharded(template, shards, p);
      times.push(r.wallMs);
      rows = merge(r.partials);
    }
    const med = median(times);
    results.push({ parallelism: p, query: queryName, medianMs: med, runs: times.map((t) => +t.toFixed(1)), rows });
    console.log(`${queryName} p=${String(p).padStart(2)}  median ${med.toFixed(1).padStart(7)} ms  [${times.map((t) => t.toFixed(0)).join(', ')}]`);
  }
}

await pool.stop();

console.log('\n## speedup vs p=1');
for (const q of ['q1', 'q6']) {
  const base = results.find((r) => r.query === q && r.parallelism === 1).medianMs;
  const line = results
    .filter((r) => r.query === q)
    .map((r) => `p=${r.parallelism}: ${(base / r.medianMs).toFixed(2)}x`)
    .join('  ');
  console.log(`${q}  ${line}`);
}

console.log('\n## correctness check (merged result vs single-instance)');
console.log(JSON.stringify(results.find((r) => r.query === 'q1' && r.parallelism === 1).rows));
console.log(JSON.stringify(results.find((r) => r.query === 'q6' && r.parallelism === maxP).rows));

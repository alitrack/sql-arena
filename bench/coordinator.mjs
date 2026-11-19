/**
 * Shard-parallel query coordinator.
 *
 * duckdb-wasm compiles without threads in the default bundle, so a single
 * instance uses one core. This layer instead runs N independent instances, each
 * scanning a disjoint subset of the shards, and merges partial aggregates. The
 * only data that crosses threads is the partial result rows.
 */
import { Worker } from 'node:worker_threads';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);

/** Partial aggregation for TPC-H Q1: every term is additive, so averages are
 *  reconstructed from sums and counts at the coordinator. */
const Q1_PARTIAL = `
select l_returnflag, l_linestatus,
  sum(l_quantity)::DOUBLE as sum_qty,
  sum(l_extendedprice)::DOUBLE as sum_base_price,
  sum(l_extendedprice*(1-l_discount))::DOUBLE as sum_disc_price,
  sum(l_extendedprice*(1-l_discount)*(1+l_tax))::DOUBLE as sum_charge,
  sum(l_quantity)::DOUBLE as qty_for_avg,
  sum(l_extendedprice)::DOUBLE as price_for_avg,
  sum(l_discount)::DOUBLE as disc_for_avg,
  count(*) as count_order
from read_parquet([__FILES__])
where l_shipdate <= date '1998-12-01' - interval '90' day
group by l_returnflag, l_linestatus`;

const Q6_PARTIAL = `
select sum(l_extendedprice*l_discount)::DOUBLE as revenue
from read_parquet([__FILES__])
where l_shipdate >= date '1994-01-01' and l_shipdate < date '1995-01-01'
  and l_discount between 0.05 and 0.07 and l_quantity < 24`;

class Pool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.seq = 1;
    this.waiters = new Map();
    this.initMs = 0;
  }

  async start() {
    const t0 = performance.now();
    this.workers = Array.from({ length: this.size }, () => new Worker(path.join(BENCH_DIR, 'worker.mjs')));
    for (const w of this.workers) {
      w.on('message', (msg) => {
        if (msg.type === 'ready') return;
        const waiter = this.waiters.get(msg.id);
        if (!waiter) return;
        this.waiters.delete(msg.id);
        if (msg.type === 'error') waiter.reject(new Error(msg.message));
        else waiter.resolve(msg);
      });
    }
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise((resolve) => {
            w.once('message', (m) => m.type === 'ready' && resolve());
            w.postMessage({ type: 'init' });
          }),
      ),
    );
    this.initMs = performance.now() - t0;
  }

  /** @returns {Promise<{rows: any[], elapsedMs: number}>} */
  runOne(workerIndex, template, shards) {
    const id = this.seq++;
    const worker = this.workers[workerIndex];
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      worker.postMessage({ type: 'query', id, template, shards });
    });
  }

  /**
   * @param {string} template partial SQL with __FILES__
   * @param {string[]} shards
   * @param {number} parallelism number of workers to use (<= pool size)
   */
  async runSharded(template, shards, parallelism) {
    const buckets = Array.from({ length: parallelism }, () => []);
    shards.forEach((s, i) => buckets[i % parallelism].push(s));
    const t0 = performance.now();
    const results = await Promise.all(
      buckets.filter((b) => b.length > 0).map((b, i) => this.runOne(i, template, b)),
    );
    const wallMs = performance.now() - t0;
    return { partials: results.map((r) => r.rows), wallMs, workerMs: results.map((r) => r.elapsedMs) };
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

/** Merge Q1 partials exactly the way a distributed engine would. */
export function mergeQ1(partials) {
  const acc = new Map();
  for (const rows of partials) {
    for (const r of rows) {
      const key = `${r.l_returnflag}|${r.l_linestatus}`;
      const cur = acc.get(key) ?? {
        l_returnflag: r.l_returnflag,
        l_linestatus: r.l_linestatus,
        sum_qty: 0, sum_base_price: 0, sum_disc_price: 0, sum_charge: 0,
        qty_for_avg: 0, price_for_avg: 0, disc_for_avg: 0, count_order: 0,
      };
      for (const k of ['sum_qty', 'sum_base_price', 'sum_disc_price', 'sum_charge',
        'qty_for_avg', 'price_for_avg', 'disc_for_avg', 'count_order']) {
        cur[k] += Number(r[k]);
      }
      acc.set(key, cur);
    }
  }
  return [...acc.values()]
    .map((r) => ({
      l_returnflag: r.l_returnflag,
      l_linestatus: r.l_linestatus,
      sum_qty: r.sum_qty,
      sum_base_price: r.sum_base_price,
      sum_disc_price: r.sum_disc_price,
      sum_charge: r.sum_charge,
      avg_qty: r.qty_for_avg / r.count_order,
      avg_price: r.price_for_avg / r.count_order,
      avg_disc: r.disc_for_avg / r.count_order,
      count_order: r.count_order,
    }))
    .sort((a, b) => (a.l_returnflag + a.l_linestatus).localeCompare(b.l_returnflag + b.l_linestatus));
}

export function mergeQ6(partials) {
  let revenue = 0;
  for (const rows of partials) for (const r of rows) revenue += Number(r.revenue ?? 0);
  return [{ revenue }];
}

/** @param {string} dir */
export function listShards(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.parquet'))
    .sort()
    .map((f) => path.join(dir, f));
}

export { Pool, Q1_PARTIAL, Q6_PARTIAL };

/**
 * SQL Arena driver: user-supplied data, user-written SQL, three engines.
 *
 * Flow: parse CSV once -> infer one schema -> hand the same schema to every
 * engine -> run the statement on all three -> compare rows and timing.
 */
import { parseCsv, inferSchema } from '/src/csv-schema.js';
import { ENGINES } from '/src/engines.js';
import { compareResults, isOrdered } from '/src/result-compare.js';

const $ = (id) => document.getElementById(id);

/** @type {Array<{name:string, columns:any[], rows:string[][]}>} */
const datasets = [];
/** @type {any[]} */
let engines = [];
let busy = false;

const DEMO_FILES = {
  orders: '/data/orders_20k.csv',
  lineitem: '/data/lineitem_20k.csv',
  customer: '/data/customer_20k.csv',
  nation: '/data/nation.csv',
  region: '/data/region.csv',
};

const EXAMPLES = {
  'select-1': `SELECT l_returnflag, l_linestatus,
       sum(l_quantity) AS sum_qty,
       sum(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
       count(*) AS n
FROM lineitem
GROUP BY l_returnflag, l_linestatus
ORDER BY l_returnflag, l_linestatus`,
  join: `SELECT n.n_name AS nation, r.r_name AS region, count(*) AS orders,
       sum(o.o_totalprice) AS revenue
FROM orders o
JOIN customer c ON o.o_custkey = c.c_custkey
JOIN nation n ON c.c_nationkey = n.n_nationkey
JOIN region r ON n.n_regionkey = r.r_regionkey
GROUP BY n.n_name, r.r_name
ORDER BY revenue DESC
LIMIT 8`,
  window: `SELECT l_returnflag, l_linestatus, sum(l_quantity) AS qty,
       rank() OVER (PARTITION BY l_returnflag ORDER BY sum(l_quantity) DESC) AS rk
FROM lineitem
GROUP BY l_returnflag, l_linestatus
ORDER BY l_returnflag, rk`,
  cte: `WITH big AS (
  SELECT o_custkey, count(*) AS n, sum(o_totalprice) AS total
  FROM orders GROUP BY o_custkey
)
SELECT c.c_mktsegment, count(*) AS customers, sum(b.total) AS revenue
FROM big b JOIN customer c ON b.o_custkey = c.c_custkey
GROUP BY c.c_mktsegment
ORDER BY revenue DESC`,
};

function setStatus(text) {
  $('status').textContent = text;
}

/**
 * Turn one CSV file into a dataset under a name the user can query.
 * @param {string} name
 * @param {string} text
 */
function addDataset(name, text) {
  const rows = parseCsv(text);
  const { columns, rows: body } = inferSchema(rows);
  if (columns.length === 0) throw new Error(`${name}: 空文件`);
  const existing = datasets.findIndex((d) => d.name === name);
  const ds = { name, columns, rows: body };
  if (existing >= 0) datasets[existing] = ds;
  else datasets.push(ds);
  return ds;
}

function renderDatasets() {
  const list = $('dslist');
  list.innerHTML = '';
  for (const ds of datasets) {
    const li = document.createElement('li');
    const types = ds.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    li.innerHTML = `<b>${ds.name}</b> — ${ds.rows.length.toLocaleString()} 行 · <span class="muted">${ds.columns.length} 列</span>`;
    li.title = types;
    list.appendChild(li);
  }
  $('dsinfo').textContent = datasets.length
    ? `${datasets.length} 张表，共 ${datasets.reduce((n, d) => n + d.rows.length, 0).toLocaleString()} 行`
    : '尚未加载数据';
  $('run').disabled = datasets.length === 0 || engines.length === 0 || busy;
  $('explain').disabled = $('run').disabled;
}

function renderCards(results) {
  const wrap = $('cards');
  wrap.innerHTML = '';
  const fastest = Math.min(...results.filter((r) => r.ok).map((r) => r.ms));
  for (const r of results) {
    const card = document.createElement('div');
    card.className = `card${r.ok ? '' : ' failed'}`;
    const cmp = r.compare;
    let pill = '<span class="pill bad">失败</span>';
    if (r.ok) {
      if (cmp?.equal && cmp.orderMatches) pill = '<span class="pill ok">结果一致</span>';
      else if (cmp?.equal) pill = '<span class="pill warn">值一致 · 顺序不同</span>';
      else if (cmp?.missingColumns?.length) pill = '<span class="pill warn">列名不同</span>';
      else pill = '<span class="pill bad">结果分歧</span>';
    }
    const rel = fastest > 0 && r.ok ? (r.ms / fastest) : null;
    card.innerHTML = `
      <div class="name">${r.name} ${pill}</div>
      <div class="time">${r.ok ? r.ms.toFixed(1) + ' <span class="muted" style="font-size:13px">ms</span>' : '—'}</div>
      <div class="meta">${r.ok ? `${r.rows.length} 行${rel ? ` · ${rel.toFixed(2)}× 最慢档` : ' · 最快'}` : ''}</div>
      ${r.ok && rel ? `<div class="bar" style="width:${Math.max(6, (fastest / r.ms) * 100)}%;${r.ms === fastest ? '' : 'background:#f58518'}"></div>` : ''}
      ${r.ok ? '' : `<div class="meta" style="color:#b42318;margin-top:6px">${escapeHtml(r.error)}</div>`}
      ${r.ok && cmp && !cmp.equal && cmp.firstDiff ? `<div class="meta" style="margin-top:6px">首个差异：${escapeHtml(JSON.stringify(cmp.firstDiff))}</div>` : ''}
    `;
    wrap.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderVerdict(results, sql) {
  const okOnes = results.filter((r) => r.ok);
  const el = $('verdict');
  if (okOnes.length === 0) {
    el.innerHTML = '<span class="bad">三个引擎都失败了</span> — 先检查 SQL 是否是三方都支持的方言。';
    return;
  }
  const ordered = isOrdered(sql);
  const allEqual = okOnes.every((r) => r.compare?.equal);
  const allOrder = okOnes.every((r) => r.compare?.orderMatches);
  const fastest = okOnes.reduce((a, b) => (a.ms <= b.ms ? a : b));
  const slowest = okOnes.reduce((a, b) => (a.ms >= b.ms ? a : b));

  const parts = [];
  if (okOnes.length < results.length) {
    parts.push(`<span class="warn">${results.length - okOnes.length} 个引擎执行失败</span>（方言不兼容，见卡片）`);
  }
  parts.push(allEqual
    ? `结果${allOrder ? '' : '按多重集'}一致`
    : '<span class="bad">结果存在分歧</span>');
  if (okOnes.length > 1) {
    parts.push(`最快 <b>${fastest.name}</b> ${fastest.ms.toFixed(1)}ms，最慢 ${slowest.name} ${slowest.ms.toFixed(1)}ms（${(slowest.ms / Math.max(fastest.ms, 0.01)).toFixed(1)}×）`);
  }
  if (!ordered) parts.push('<span class="muted">查询没有 ORDER BY，按行集合比较（忽略顺序）</span>');
  el.innerHTML = parts.join(' · ');
}

function renderTable(results, activeIdx) {
  const wrap = $('tablewrap');
  const r = results[activeIdx];
  if (!r || !r.ok) {
    wrap.innerHTML = `<div class="muted" style="padding:8px">${r ? '该引擎执行失败：' + escapeHtml(r.error) : '无结果'}</div>`;
    return;
  }
  if (r.rows.length === 0) {
    wrap.innerHTML = '<div class="muted" style="padding:8px">0 行</div>';
    return;
  }
  const cols = r.columns.length ? r.columns : Object.keys(r.rows[0]);
  const head = `<tr><th>#</th>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
  const body = r.rows
    .slice(0, 200)
    .map((row, i) => `<tr><td class="muted">${i + 1}</td>${cols.map((c) => `<td>${formatCell(row[c])}</td>`).join('')}</tr>`)
    .join('');
  const more = r.rows.length > 200 ? `<div class="muted" style="padding:6px">仅显示前 200 行，共 ${r.rows.length} 行</div>` : '';
  wrap.innerHTML = `<table>${head}${body}</table>${more}`;
}

function formatCell(v) {
  if (v === null || v === undefined) return '<span class="muted">NULL</span>';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(4);
  return escapeHtml(String(v));
}

function renderTabs(results, activeIdx, onPick) {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  results.forEach((r, i) => {
    const b = document.createElement('button');
    b.textContent = r.name;
    b.setAttribute('aria-selected', String(i === activeIdx));
    b.onclick = () => onPick(i);
    tabs.appendChild(b);
  });
}

async function ensureEngines() {
  if (engines.length) return engines;
  setStatus('正在启动三个引擎…');
  const started = await Promise.all(
    ENGINES.map(async (make) => {
      const e = make();
      try {
        await e.init();
        return e;
      } catch (error) {
        return { name: e.name, version: e.version, initError: String(error?.message ?? error) };
      }
    }),
  );
  engines = started;
  return engines;
}

async function loadIntoEngines() {
  const usable = engines.filter((e) => !e.initError);
  for (const ds of datasets) {
    setStatus(`导入 ${ds.name}（${ds.rows.length.toLocaleString()} 行）…`);
    await Promise.all(usable.map((e) => e.load(ds)));
  }
}

async function run() {
  if (busy) return;
  const sql = $('sql').value.trim();
  if (!sql) return;
  busy = true;
  $('run').disabled = true;
  $('explain').disabled = true;
  try {
    await ensureEngines();
    renderDatasets();
    await loadIntoEngines();

    const usable = engines.filter((e) => !e.initError);
    const warm = $('warm').checked;
    const ordered = isOrdered(sql);
    setStatus(warm ? '执行（先热身一次）…' : '执行…');

    const results = await Promise.all(
      usable.map(async (e) => {
        try {
          if (warm) await e.run(sql);
          const r = await e.run(sql);
          return { name: e.name, ok: true, ms: r.ms, rows: r.rows, columns: r.columns };
        } catch (error) {
          return { name: e.name, ok: false, ms: 0, rows: [], columns: [], error: String(error?.message ?? error) };
        }
      }),
    );

    // Baseline = the first engine that produced rows.
    const base = results.find((r) => r.ok);
    for (const r of results) {
      if (!r.ok) continue;
      r.compare = base === r
        ? { equal: true, orderMatches: true, missingColumns: [] }
        : compareResults(base, r, { ordered });
    }

    let activeIdx = 0;
    const draw = () => {
      renderCards(results);
      renderVerdict(results, sql);
      renderTabs(results, activeIdx, (i) => { activeIdx = i; draw(); });
      renderTable(results, activeIdx);
    };
    draw();
    window.__lastResults = results.map((r) => ({
      name: r.name, ok: r.ok, ms: r.ms, rows: r.rows.length,
      columns: r.columns, compare: r.compare ?? null,
      error: r.error ?? null, firstRows: r.rows.slice(0, 3),
    }));
    setStatus(`完成 · ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatus('出错：' + String(error?.message ?? error));
  } finally {
    busy = false;
    $('run').disabled = datasets.length === 0;
    $('explain').disabled = datasets.length === 0;
  }
}

async function showExplain() {
  const sql = $('sql').value.trim();
  if (!sql) return;
  const usable = engines.filter((e) => !e.initError);
  if (!usable.length) { setStatus('先执行一次以启动引擎'); return; }
  const lines = [];
  for (const e of usable) {
    try {
      const plan = await e.run(`EXPLAIN ${sql}`);
      const text = plan.rows.map((r) => Object.values(r).join(' ')).join('\n');
      lines.push(`-- ${e.name}\n${text}`);
    } catch (error) {
      lines.push(`-- ${e.name}\n(不支持 EXPLAIN: ${String(error?.message ?? error).slice(0, 120)})`);
    }
  }
  $('tablewrap').innerHTML = `<pre class="sql">${escapeHtml(lines.join('\n\n'))}</pre>`;
}

$('demo').onclick = async () => {
  try {
    setStatus('载入内置示例…');
    await window.__arena.loadDemo();
    setStatus('示例已载入');
  } catch (error) {
    setStatus('示例载入失败：' + String(error?.message ?? error));
  }
};

$('files').onchange = async (event) => {
  const files = [...event.target.files];
  for (const file of files) {
    const text = await file.text();
    const name = file.name.replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_]+/g, '_');
    addDataset(name, text);
  }
  renderDatasets();
};

$('run').onclick = run;
$('explain').onclick = showExplain;

for (const a of document.querySelectorAll('[data-q]')) {
  a.onclick = (e) => {
    e.preventDefault();
    $('sql').value = EXAMPLES[a.dataset.q];
  };
}

// The driver scripts assert on these instead of scraping the DOM.
window.__arena = {
  datasets: () => datasets.map((d) => ({ name: d.name, rows: d.rows.length, columns: d.columns })),
  loadDemo: async () => {
    for (const [name, url] of Object.entries(DEMO_FILES)) {
      const r = await fetch(url);
      // A missing dataset used to surface as "column does not exist" because the
      // 404 body was parsed as CSV. Fail with the actual cause instead.
      if (!r.ok) {
        throw new Error(`示例数据缺失：${url} (HTTP ${r.status})。先运行 ./scripts/make-data.sh`);
      }
      const text = await r.text();
      if (/^\s*</.test(text)) {
        throw new Error(`示例数据缺失：${url} 返回 HTML 而不是 CSV。先运行 ./scripts/make-data.sh`);
      }
      addDataset(name, text);
    }
    renderDatasets();
    return datasets.length;
  },
  runSql: async (sql) => {
    $('sql').value = sql;
    await run();
    return window.__lastResults;
  },
  explain: showExplain,
};
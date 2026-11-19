"""
Generates report/index.html from measured numbers.

Keeps the charts inline SVG so the report is a single file with no network
dependencies: it opens from disk and renders anywhere.
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "index.html"

# ---- measured data (this machine, 2026-11-19) ----
SCALE = [
    # workers, q1_ms, q6_ms  (SF1: 6.0M rows / 196 MB, 16 shards; medians of 5-7 runs)
    (1, 250.6, 89.1),
    (2, 125.4, 44.2),
    (4, 68.2, 26.1),
    (8, 36.2, 14.3),
    (16, 24.3, 9.1),
]

SF10 = [(1, 2421.4, 911.6), (4, 647.2, 231.5), (8, 331.2, 118.7), (16, 150.6, 64.6)]

ENGINES = [
    # name, load ms, q1 ms, q6 ms  (2M rows)
    ("DuckDB-Wasm", 314, 55, 8),
    ("SQLite-Wasm", 15439, 840, 120),
    ("PGlite 18", 6074, 1306, 153),
]

SINGLE = [
    # label, q1 ms, q6 ms — all warm, same process, medians (native: 3 runs each)
    ("wasm 1 instance", 250.6, 89.1),
    ("native 1 thread", 168, 58),
    ("native 32 threads", 14, 7),
    ("wasm 16 workers", 24.3, 9.1),
]


def bar_chart(rows, unit="ms", width=680, bar_h=26, gap=10, label_w=150, max_val=None):
    """Horizontal bar chart as inline SVG."""
    max_val = max_val or max(r[1] for r in rows)
    height = len(rows) * (bar_h + gap) + 20
    plot_w = width - label_w - 90
    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" height="{height}" role="img">']
    for i, (label, value, color) in enumerate(rows):
        y = i * (bar_h + gap) + 6
        w = max(2, plot_w * value / max_val)
        parts.append(
            f'<text x="0" y="{y + bar_h * 0.72}" font-size="12" fill="#333">{label}</text>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y}" width="{w:.1f}" height="{bar_h}" fill="{color}" rx="3"/>'
        )
        parts.append(
            f'<text x="{label_w + w + 8:.1f}" y="{y + bar_h * 0.72}" font-size="12" '
            f'fill="#333" font-variant-numeric="tabular-nums">{value:,}{unit}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


scale_rows = [(f"{w} worker{'s' if w > 1 else ''}", round(q1), "#4c78a8") for w, q1, _ in SCALE]
engine_rows = [(n, q1, c) for (n, _, q1, _), c in zip(ENGINES, ["#4c78a8", "#f58518", "#54a24b"])]
single_rows = [(n, q1, c) for (n, q1, _), c in zip(SINGLE, ["#4c78a8", "#72b7b2", "#e45756", "#54a24b"])]

speedup = [f"{SCALE[0][1] / q1:.2f}×" for _, q1, _ in SCALE]
sf10_speedup = [f"{SF10[0][1] / q1:.2f}×" for _, q1, _ in SF10]

html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>DuckDB-Wasm 实验报告：并行、持久化与引擎对比</title>
<style>
  body {{ font: 15px/1.7 -apple-system, "Segoe UI", system-ui, sans-serif; max-width: 900px;
         margin: 40px auto; padding: 0 24px; color: #1a1a1a; }}
  h1 {{ font-size: 26px; margin-bottom: 4px; }}
  h2 {{ font-size: 19px; margin-top: 40px; border-bottom: 1px solid #e5e5e5; padding-bottom: 6px; }}
  h3 {{ font-size: 16px; margin-top: 26px; }}
  .meta {{ color: #666; font-size: 13px; margin-bottom: 28px; }}
  table {{ border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }}
  th, td {{ border: 1px solid #ddd; padding: 7px 10px; text-align: right;
           font-variant-numeric: tabular-nums; }}
  th:first-child, td:first-child {{ text-align: left; }}
  th {{ background: #fafafa; font-weight: 600; }}
  code {{ background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-size: 13px; }}
  .verdict {{ background: #f0f7ff; border-left: 3px solid #4c78a8; padding: 12px 16px; margin: 18px 0; }}
  .warn {{ background: #fff8e6; border-left: 3px solid #d9a441; padding: 12px 16px; margin: 18px 0; }}
  .pass {{ color: #157f3d; font-weight: 600; }}
  ul {{ padding-left: 22px; }}
  .small {{ font-size: 13px; color: #666; }}
</style>
</head>
<body>

<h1>DuckDB-Wasm 三个方向的实验结果</h1>
<p class="meta">
  实测环境：Apple M3 Ultra（32 核）/ 256 GiB / macOS 26.6 / Node 24.18 / Chromium 145 / DuckDB 2.0.0 (native)
  · duckdb-wasm 1.33.1-dev118（内嵌 DuckDB 1.5.4）· 2026-11-19
</p>

<div class="verdict">
  <b>三句话结论</b>
  <ul>
    <li>分片并行把单线程的短板基本补上了：16 个 wasm 实例在 SF1 上把 Q1 从 251ms 压到 24ms（<b>10.3×</b>），
        追到原生 32 线程（14ms）的 1.7× 以内，但没有反超。</li>
    <li>本地优先运行时成立：OPFS + 跨标签页单写者 + 迁移 + 导出全部实测通过（10/10），
        导出的 <code>.duckdb</code> 能被原生 CLI 直接打开。</li>
    <li>三引擎同页对比：200 万行下 DuckDB 聚合比 SQLite 快约 15×、比 PGlite 快约 24×，
        而三家结果一致到 1e-14。</li>
  </ul>
</div>

<h2>1. 分片并行：把“单线程”这个天花板绕过去</h2>
<p>
  duckdb-wasm 默认 bundle 是编译成单线程的，<code>SET threads=4</code> 会直接报
  <code>DuckDB was compiled without threads</code>。但“单实例单线程”不等于“只能用一核”：
  可以起 N 个独立实例，每个扫一部分分片，各自算部分聚合，主线程只合并几十行结果。
</p>
<p>数据：TPC-H lineitem SF1（600 万行 / 196 MB），切成 16 个 parquet 分片；每个配置扫同样的分片，只改 worker 数。</p>

{bar_chart(scale_rows, "ms")}

<table>
  <tr><th>worker</th><th>Q1 中位数</th><th>加速比</th><th>Q6 中位数</th></tr>
  {"".join(f"<tr><td>{w}</td><td>{q1:.1f} ms</td><td>{SF1_SP}</td><td>{q6:.1f} ms</td></tr>" for (w, q1, q6), SF1_SP in zip(SCALE, speedup))}
</table>

<h3>和原生引擎放在一起看（SF1，Q1）</h3>
{bar_chart(single_rows, "ms")}

<table>
  <tr><th>配置</th><th>Q1</th><th>Q6</th><th>相对 wasm 单实例</th></tr>
  {"".join(f"<tr><td>{n}</td><td>{q1} ms</td><td>{q6} ms</td><td>{SINGLE[0][1] / q1:.2f}×</td></tr>" for n, q1, q6 in SINGLE)}
</table>

<p class="small">
  说明：16 worker 的 Q1 在多次运行间波动较大（19–24 ms，16 个 JIT 实例互相争抢调度），
  取中位数并保留这一区间；1 worker 与 8 worker 的波动小于 5%。
</p>
<p class="small">
  wasm 单实例比原生单线程慢约 1.5×（251 vs 168ms）——这是 wasm 的真实单核开销。
  16 个 wasm 实例把差距压到 1.7×（24 vs 14ms），但<b>没有反超</b>：原生多线程共享一份已解压的
  column chunk 缓存，而 16 个实例各自读各自的 parquet 分片，压缩数据被重复解压、页缓存也不共享。
  早年我若拿"wasm 热态"去比"原生冷态（含进程启动）"会得出反超的错误结论；把两边都放到同一进程里
  跑热态后，原生仍然领先。代价还包括内存：每个实例一份 wasm 堆（本例约 120 MB/实例）。
</p>

<h3>更大规模（SF10：6000 万行 / 2.1 GB）</h3>
<table>
  <tr><th>worker</th><th>Q1</th><th>加速比</th><th>Q6</th></tr>
  {"".join(f"<tr><td>{w}</td><td>{q1:.0f} ms</td><td>{sp}</td><td>{q6:.0f} ms</td></tr>" for (w, q1, q6), sp in zip(SF10, sf10_speedup))}
</table>
<p class="small">
  SF10 上 16 worker 达到 16.1×，接近线性；Q6 在 16 worker 时略低于线性（14.1×），
  因为它的总耗时已经压到 65ms，worker 启动与结果合并占比变大。注意 SF10 的 16 worker（151ms）
  仍然慢于原生 32 线程（SF10 热态实测 90ms，四次中位），并行层的作用是"把单线程的 16 倍差距缩到 1.7 倍"，
  而不是"比原生快"。
</p>

<div class="warn">
  <b>什么时候不该用这招</b>：单次查询少于 ~50ms、或者数据本来就小（&lt;100 万行）时，
  16 个实例的 2.8s 池初始化成本永远收不回来。它适合“长驻会话 + 大表反复查”，
  不适合“打开页面查一次就走”。
</div>

<h2>2. 本地优先运行时：OPFS + 跨标签页</h2>
<p>
  duckdb-wasm 的 OPFS 只解决“文件能持久化”。真做本地优先应用还要解决：
  两个标签页同时打开同一个库怎么办、schema 怎么演进、浏览器随时被杀时数据怎么不丢、
  用户怎么把数据带走。这一层目前没有现成库。
</p>

<h3>实测结果（Playwright 驱动真实 Chromium）</h3>
<table>
  <tr><th>行为</th><th>结果</th><th>说明</th></tr>
  <tr><td>首个标签页拿到写锁成为 leader</td><td class="pass">通过</td><td>navigator.locks，ifAvailable 探测</td></tr>
  <tr><td>迁移只跑一次并记录版本</td><td class="pass">通过</td><td>_schema_migrations 表，事务内 bump</td></tr>
  <tr><td>刷新后数据还在</td><td class="pass">通过</td><td>1000 行，CHECKPOINT 后重载仍为 1000</td></tr>
  <tr><td>第二个标签页降级为 client</td><td class="pass">通过</td><td>BroadcastChannel 代理 SQL</td></tr>
  <tr><td>client 能读 leader 的数据</td><td class="pass">通过</td><td>代理查询返回 1000 行</td></tr>
  <tr><td>leader 关闭后 client 接管</td><td class="pass">通过</td><td>锁释放 → 重新竞争 → 数据仍在</td></tr>
  <tr><td>导出 .duckdb 字节</td><td class="pass">通过</td><td>1,323,008 字节</td></tr>
  <tr><td>原生 CLI 能打开导出的库</td><td class="pass">通过</td><td>duckdb 2.0.0 读出 500 行 / 24750.00</td></tr>
</table>

<h3>踩到的三个真实坑（文档没写）</h3>
<ul>
  <li><b>OPFS 路径不是根目录</b>：1.33 把库放在 <code>duckdb/fs/&lt;name&gt;</code>，
      临时文件在 <code>duckdb/scratch/</code>。按文档的思路从根目录找文件会 NotFound。</li>
  <li><b>DuckDB 没有 <code>PRAGMA user_version</code></b>：SQLite 的迁移惯例在这里不成立，
      要自己建元数据表。</li>
  <li><b>锁回调不能 await</b>：<code>navigator.locks.request()</code> 的 promise 在锁释放前不 resolve，
      在回调里 await 一个“保持到 destroy”的 promise 会把 start() 直接挂死。必须先 resolve 一个就绪信号，
      再单独挂起。</li>
</ul>

<h2>3. 三引擎同页对比（DuckDB / SQLite / PGlite）</h2>
<p>
  同一个标签页、同一份 CSV（TPC-H lineitem 20 万行，按 repeat 参数放大）、同一套 SQL 语义。
  方言差异显式处理：DuckDB 和 Postgres 支持 <code>DATE '1994-01-01'</code> 字面量，SQLite 不支持，
  只能存 ISO 文本做字符串比较。
</p>

<h3>200 万行（CSV 24.6 MB × 10）</h3>
{bar_chart(engine_rows, "ms")}
<table>
  <tr><th>引擎</th><th>版本</th><th>导入</th><th>Q1 聚合</th><th>Q6 过滤</th><th>Q6 结果</th></tr>
  <tr><td>DuckDB-Wasm</td><td>1.5.4</td><td>314 ms</td><td>55 ms</td><td>8 ms</td><td>40,649,752.62</td></tr>
  <tr><td>SQLite-Wasm</td><td>3.54.1</td><td>15,439 ms</td><td>840 ms</td><td>120 ms</td><td>40,649,752.62</td></tr>
  <tr><td>PGlite (Postgres 18)</td><td>18.6</td><td>6,074 ms</td><td>1,306 ms</td><td>153 ms</td><td>40,649,752.62</td></tr>
</table>

<h3>规模阶梯（Q1 聚合，ms）</h3>
<table>
  <tr><th>行数</th><th>DuckDB</th><th>SQLite</th><th>PGlite</th><th>DuckDB 优势</th></tr>
  <tr><td>20 万</td><td>8</td><td>79</td><td>72</td><td>9–10×</td></tr>
  <tr><td>100 万</td><td>28</td><td>405</td><td>600</td><td>14–21×</td></tr>
  <tr><td>200 万</td><td>55</td><td>840</td><td>1,306</td><td>15–24×</td></tr>
</table>

<p class="small">
  为什么是这个数量级：DuckDB 是列存 + 向量化执行 + 直接读 Parquet/CSV 的零拷贝路径；
  SQLite 是行存 B-tree，聚合要逐行解码；PGlite 走 Postgres 的堆表 + wasm3 解释执行，
  每次查询还有协议层开销。三家的 Q6 结果一致到 1e-14，说明差的是执行方式，不是正确性。
</p>

<div class="warn">
  <b>别误读这张表</b>：SQLite 在这三个引擎里导入最慢（15.4s），但它的价值是事务、并发、
  小对象读写和 30 年生态，不是 OLAP 聚合。拿它跑分析查询本来就不是它的战场；
  反过来，DuckDB 也不适合高频单行 UPDATE。
</div>

<h2>4. 跨机器访问：为什么 http 不行</h2>
<p>
  把服务绑到 <code>0.0.0.0</code> 只解决“能不能连上”。真正卡住的是浏览器的安全上下文：
  OPFS、Web Locks、SharedArrayBuffer 只在 secure context 暴露，而
  <code>http://localhost</code> 算 secure context，<code>http://192.168.1.50</code> 不算。
</p>
<table>
  <tr><th>访问方式</th><th>isSecureContext</th><th>navigator.storage (OPFS)</th><th>navigator.locks</th><th>SharedArrayBuffer</th></tr>
  <tr><td>http://localhost:8765</td><td class="pass">true</td><td class="pass">有</td><td class="pass">有</td><td class="pass">有</td></tr>
  <tr><td>http://192.168.1.50:8765</td><td style="color:#b42318;font-weight:600">false</td><td style="color:#b42318">undefined</td><td style="color:#b42318">undefined</td><td style="color:#b42318">无</td></tr>
  <tr><td>https://192.168.1.50:8765</td><td class="pass">true</td><td class="pass">有</td><td class="pass">有</td><td class="pass">有</td></tr>
</table>
<p class="small">
  实测脚本 <code>test/lan-probe.mjs</code> / <code>test/lan-probe-tls.mjs</code>。
  https 下 <code>crossOriginIsolated=true</code>（COOP/COEP 生效），本地优先运行时在远端机器上
  完整可用：leader 选举、500 行写入、第二个标签页读、关闭后接管，全部通过。
  代价是自签证书警告（另一台机器点一次继续），或用 mkcert 签本机 CA。
</p>

<h2>5. 结论与建议</h2>
<ul>
  <li><b>要做分析型产品</b>：DuckDB-Wasm 是唯一正确选择，尤其数据在 Parquet/CSV/对象存储上。</li>
  <li><b>数据 &gt; 500 万行且反复查</b>：上分片并行层，16 worker 在本机是甜点（内存换速度）。</li>
  <li><b>要"打开即用、下次还在"</b>：必须自己做运行时（OPFS + 锁 + 迁移 + 导出），
      直接用 duckdb-wasm 会在多标签页和升级路径上踩坑。</li>
  <li><b>需要事务/高并发小写入</b>：SQLite-Wasm 或 PGlite 更合适，别硬用 DuckDB。</li>
  <li><b>版本</b>：<code>npm i @duckdb/duckdb-wasm</code> 会拿到 OPFS 坏的 dev57，
      必须钉 <code>1.32.0</code> 或 <code>@next</code>（≥ dev61）。</li>
</ul>

<p class="small" style="margin-top:36px">
  复现：<code>./scripts/make-data.sh</code> 重建数据 →
  <code>node bench/scale.mjs</code> / <code>node test/run-compare.mjs</code> /
  <code>node test/run-warehouse.mjs</code>（后两者需先 <code>node test/server.mjs</code>）。
  所有数字均由本机实测脚本产出，未引用二手来源；parquet 数据不进仓库，脚本可重建。
</p>

</body>
</html>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(html, encoding="utf-8")
print(f"wrote {OUT} ({len(html)} bytes)")

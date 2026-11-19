# SQL Arena — DuckDB / SQLite / PGlite 同场 PK

在浏览器里用同一份数据、同一句 SQL 同时跑三个引擎。数据由用户提供，SQL 由用户编写。

三个引擎都在 wasm 里跑，没有服务端参与计算。

```
public/arena.html      SQL Arena：自定义数据 + 自定义 SQL + 三引擎 PK
public/compare.html    固定 SQL 的三引擎对比（早期版本，保留作基线）
public/warehouse.html  本地优先运行时 demo（OPFS + 跨标签页）
src/csv-schema.js      CSV 解析 + 类型推断（三引擎共用同一份 schema）
src/engines.js         三个引擎的统一适配层
src/result-compare.js  跨引擎结果比较（容差 / 无序比较 / 布尔归一）
src/warehouse.js       本地优先运行时
bench/                 分片并行查询层（多 worker + 两阶段聚合）
test/                  Playwright 驱动 + 静态服务器
report/                自包含 HTML 报告
```

## 在线地址

<https://alitrack.github.io/sql-arena/>

托管在 GitHub Pages。首屏要下载 DuckDB 的 wasm（32 MB，Pages 不做 gzip），
从中国大陆访问 GitHub CDN 实测只有 5–25 KB/s，首次打开需要数分钟；本地
`npm run serve` 没有这个问题。页面本身是纯静态的，也可以直接用任意静态服务器托管。

## 快速开始

```sh
npm run setup                  # 安装依赖 + 拉 wasm 产物（49MB，不入库）
npm run serve                  # http://localhost:8791
```

打开 `http://localhost:8791/public/arena.html`。

局域网/手机访问用 `npm run serve:lan`（自动选空端口并打印可点地址）。

## 测试

```sh
npm run serve &                # 测试需要一个跑着的服务
npm run test:arena             # 三引擎跑同一句四表 JOIN，断言结果一致
npm run test:matrix            # 六种查询形态 + 方言差异矩阵
npm run test:upload            # 用户上传自定义 CSV
```

Playwright 1.61.1 已钉住；首次使用需 `npx playwright install chromium`。

## 为什么值得做：它会拦住三类假结论

同一个查询在不同引擎上「结果不一致」，很多时候不是引擎的问题，是比较方法的问题。
这个页面把这三件事在源头处理掉：

| 陷阱 | 现象 | 处理 |
|---|---|---|
| 类型不一致 | 全建成 TEXT 时 `'9' > '100'` 为真，DuckDB 只匹配 1 行而真值 2 行 | 一次推断，三家共用同一份 DDL 类型 |
| 布尔表示 | SQLite 返回 `1`，DuckDB/Postgres 返回 `true` | 比较时布尔与 0/1 视为等价 |
| 浮点尾差 | 三家求和末位不同（~1e-11） | 相对容差 1e-9，超出才算分歧 |

另外 `ORDER BY` 缺失时按行多重集比较，只把顺序差异单独标注，不算结果分歧。

## 已验证的方言差异

同一句 SQL 在三个引擎上并非都成立。实测（`node test/arena-matrix.mjs`）：

| 写法 | DuckDB | SQLite | PGlite |
|---|---|---|---|
| `WHERE d > DATE '1998-01-01'` | ✅ | ❌ 语法错误 | ✅ |
| `CAST(x AS DOUBLE)` | ✅ | ✅ | ❌ `type "double" does not exist` |

可移植写法：日期直接写字符串 `'1998-01-01'`；浮点用 `CAST(x AS REAL)` 或 `DECIMAL(18,2)`。

## 环境

Node 24 / Chromium（Playwright）。数据用原生 `duckdb` CLI 生成：

```sh
# 生成 TPC-H 数据（扩展目录写到 /tmp，避免动 ~/.duckdb）
duckdb -c "SET extension_directory='/tmp/ddb-ext'; LOAD tpch; CALL dbgen(sf=1); \
           COPY lineitem TO 'data/lineitem_sf1.parquet' (FORMAT parquet)"
```

内置示例数据用 `./scripts/make-data.sh` 重建（含 5 表的 20k 抽样 CSV）。

## 1. 分片并行

```sh
node bench/scale.mjs --shards data/shards16 --runs 5 --levels 1,2,4,8,16
```

每个 worker 是一个独立 duckdb-wasm 实例（`duckdb-node-blocking.cjs`），扫自己的分片，
只回传部分聚合（Q1 的 sum/count、Q6 的 sum），协调器合并。结果与单实例逐位一致。

## 2. 本地优先运行时

```sh
./scripts/serve.sh              # 本机：http://localhost:8791
node test/run-warehouse.mjs     # 10 项断言：持久化 / 迁移 / 跨标签页 / 接管 / 导出
```

浏览器里打开 `http://localhost:8791/public/warehouse.html` 可以手动点。

> 默认端口 **8791**，不是 8765：本机 127.0.0.1:8765 已被一个无关的 uvicorn 服务占用，
> 用 8765 会打到别人家的页面还显示 200。`serve.sh` 现在会自己往上找空端口。

### 跨机器访问（0.0.0.0）

```sh
./scripts/serve.sh --lan        # https://<你的LAN IP>:8791，自签证书
```

**http 下会怎样**：页面照常打开，但自动降级为内存模式——迁移、写入、查询、跨标签页全部
可以验证，只是刷新即丢、不能多标签页、导出会返回明确原因而不是崩。页面顶部有横幅标明当前模式。
`start()` 不再抛 `Cannot read properties of undefined (reading 'request')`。

**为什么持久化需要 https**：OPFS、Web Locks、SharedArrayBuffer 只在 secure context 里存在。
`http://localhost` 算 secure context，但 `http://192.168.1.50` 不算——浏览器会直接把
`navigator.storage` 和 `navigator.locks` 变成 `undefined`，持久化和跨标签页锁静默失效。
实测（`test/lan-probe.mjs`）：

| 访问方式 | isSecureContext | OPFS | Web Locks | SharedArrayBuffer |
|---|---|---|---|---|
| http://localhost:8791 | true | ✅ | ✅ | ✅ |
| http://192.168.1.50:8791 | **false** | ❌ | ❌ | ❌ |
| https://192.168.1.50:8791 | true | ✅ | ✅ | ✅ |

自签证书只需在另一台机器上点一次“继续访问”。想免警告就用
[mkcert](https://github.com/FiloSottile/mkcert) 签一张本机 CA 证书替换 `certs/`。

注意服务器**没有鉴权**，会暴露整个 lab 目录，只在可信网络里开。

`serve.sh` 必须常驻：用 `&` 挂在一次性 shell 里起的进程会随 shell 退出被回收。
前台跑（占一个终端），或用 `scripts/serve.sh --lan &` 后确认 `curl` 两次都返回 200。

## 3. 三引擎同页对比

```sh
node test/server.mjs &
node test/run-compare.mjs               # 20 万行
REPEAT=10 node test/run-compare.mjs     # 200 万行
```

浏览器里打开 `http://localhost:8791/public/compare.html?repeat=10`。

## 报告

```sh
python3 report/build_report.py   # → report/index.html
open report/index.html
```

## 已确认的坑

- npm `latest`（1.33.1-dev57.0）的 OPFS 是坏的，必须钉 `1.32.0` 或 `@next`（≥ dev61）。
- OPFS 里库文件在 `duckdb/fs/<name>`，临时文件在 `duckdb/scratch/`，不在根目录。
- DuckDB 没有 `PRAGMA user_version`，迁移版本要自己建表。
- `navigator.locks.request()` 的回调里不能 await 一个"持有到 destroy"的 promise，会挂死启动。
- 非 COI 的 base bundle 编译时就没有线程，`SET threads=4` 直接报错。
- DuckDB 写文件只走本地/OPFS；`COPY ... TO 'https://...'` 报 `Unsupported data protocol`。

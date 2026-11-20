# sql-arena 多领域专家评审

> 仓库 `alitrack/sql-arena` — 浏览器内用同一份数据 + 同一句 SQL 同时跑 DuckDB / SQLite / PGlite 三个 WASM 引擎并比较结果。
> 方法：5 个领域专家并行深读（DB/SQL 语义 · 前端/WASM 性能 · 安全 · 测试/CI · 构建/文档），高影响结论逐条回源码核实。
> 环境：本机无 `node_modules` / `public/vendor`（wasm 需 `npm run setup` 拉取）/ `data/`，故 Playwright 引擎测试无法实跑；比较器与 CSV 类型推断的纯函数已用 node 探针实测验证。

## 已修复（2026-11-20，经 node 实测验证）

- **C1** `src/engines.js:115-122` — SQLite INTEGER 绑定改为：`Number.isSafeInteger(n) ? n : raw`，>2^53 保留十进制文本走 INTEGER 亲和。实测 sqlite-wasm 3.54.1-build1 **无 BigInt 绑定支持**（`keys with bigint: []`），旧 `Number('12345678901234567')` 存成 `...568`（丢精度），新代码存 `...567` 精确、读回 `typeof bigint` 精确。小整数（42）仍绑 number，常见路径不变。
- **C2** `src/csv-schema.js:147-155` — `ddlType` 的 duckdb 分支把 `INTEGER` 映射为 `BIGINT`，与 pglite 对齐。实测 `inferred=INTEGER → duckdb=BIGINT / sqlite=INTEGER / pglite=BIGINT`，三家一致 64 位，消除 >2^31 只在 DuckDB 的 INT32 溢出。
- **M7** `test/arena-test.mjs` — 四表 JOIN 测试补真断言：每个引擎断言 `ok`、`compare.equal`、`orderMatches`，任一失败 `process.exit(1)` 并打印 `firstDiff`。此前引擎报错/结果分歧只 `console.log`、进程仍 0 退出，CI 实际没在守"三引擎一致"这门。

## 已修复 P1 比较器（2026-11-20，`node test/result-compare.test.mjs` 20/20 通过，本地可跑无需 wasm）

全部集中在 `src/result-compare.js`，配套纯函数回归 `test/result-compare.test.mjs`（已挂进 CI 的 `npm ci` 之后 + `package.json` 的 `test:unit`）：

- **M2 ordered 并列行假分歧** — 配对从"ordered 走位置 / unordered 走桶"统一为**始终按 key 桶配对**。`ORDER BY` 并列（tie）行不再位置错配报假分歧（实测 `{A,5},{B,5},{C,9}` vs 并列对调 → 现在 `equal=true`），真正的值分歧仍被抓住。
- **M3 unordered 顺序标注失效** — `orderMatches` 从"ordered 比原始序列 / unordered 比排序后序列（恒 true）"统一为**始终比原始 key 序列**。现在 `[1,2] vs [2,1]` 的 `orderMatches=false` 可达，UI 的"值一致·顺序不同"药丸（arena.js:107）在无序分支也能显示，README:61 承诺落地。
- **M4 rowKey 不折叠 0/1/'1'/'0'** — `asBool` 提升为模块级共享，`rowKey` 复用之。SQLite 的布尔 1/0（或文本 '1'/'0'）与 DuckDB/PG 的 true/false 现在在 key 和值两处都折叠，含布尔列的重排查询不再整行假分歧。
- **M5 isOrdered 被子查询/CTE/字面量误触发** — 重写为状态机：剥离单/双引号字面量、`--`/`/* */` 注释，按括号深度只认**顶层** `order by`。实测 `SELECT * FROM (SELECT * FROM t ORDER BY a)` → false（原为 true）；`reorder` 列名、`"order by fake"` 引号标识符、CTE 内层、多空格 `ORDER  BY` 全部正确。
- **m7 NaN** — `cellsEqual(NaN,NaN)` 改判相等；`maxRelDiff` 累加加 `Number.isFinite` 守卫，NaN 不再把报告字段污染成 NaN。
- **m8 浮点 key 精度** — `rowKey` 数值 key 从 `toPrecision(12)` 改 `toPrecision(10)`，与比较容差量级对齐（纯稳健性微调，非硬 bug）。

### M6 诊断证据（2026-11-20，本机三引擎真跑探针得出，非推测）

三引擎投影同一 `DATE '1998-09-02'` 列的**真实返回形状**：

| 引擎 | DATE | TIMESTAMP | result 里的类型信息 |
|---|---|---|---|
| DuckDB (`toJSON`) | `number` `904694400000`（epoch 毫秒，**UTC** 午夜编码）| `number`（**UTC** 墙上时钟编码）| `schema.fields[].type.typeId`（8=DATE,10=TIMESTAMP,9=TIME,2=int64）|
| PGlite | `Date` 对象（`getTime`=`904694400000`，与 DuckDB **同一 epoch**，同为 **UTC** 编码）| `Date`（同 epoch）| `fields[].dataTypeID`（1082=date,1114=timestamp,1083=time,20=int8）|
| SQLite | `string` `"1998-09-02"` | `string` | **result 无类型信息**（只有值，类型只能从值形状推断）|

**关键结论**：DuckDB 的 number 和 PGlite 的 Date 携带**同一个 epoch**（都按 UTC 墙上时钟编码 naive date/time），只有**载体**不同（number vs Date）；SQLite 则是**文本**。所以三者都能无损归一到同一个 UTC 墙上时钟文本，且与本机时区无关（用 `getUTC*` 渲染 epoch，而非 `getHours`——后者会按本机偏移漂移 8 小时）。

比较器现状：`cellsEqual(duck,pg)=true`（都归一成 number 后相等），`cellsEqual(duck,sql)=false`、`cellsEqual(pg,sql)=false` —— **投影裸 DATE 列的查询，duck/pg 一致、俩都跟 sqlite 假分歧**，报 `firstDiff: 904694400000 vs "1998-09-02"`。专家原假设"duckdb 返回 Date 对象"是错的（实际是 number），但问题真实。

## 已修复 M6 日期列跨引擎假分歧（2026-11-20，选项 a：彻底修，含 UI 一致）

**修法**（每引擎 `run()` 内部归一，`run()` 签名不变，`arena.js`/`compareResults` 零改动）：
- 新增 `src/date-normalize.js` 纯模块：`duckDateKind(typeId)` / `pgDateKind(dataTypeID)` 把各引擎 result schema 的列类型映射到 `date`/`timestamp`；`canonical(value, kind)` 把 number（DuckDB）/ Date（PGlite）/ string（SQLite）三种载体统一渲染成 **UTC 墙上时钟文本**（date→`YYYY-MM-DD`，timestamp→`YYYY-MM-DD HH:MM:SS`）；`kindFromText`/`canonicalTextIfDate` 给无类型的 SQLite 用值形状兜底。
- `src/engines.js` 三个 adapter 的 `run()` 各按自己的 result schema 取列类型，只把**确认为日期列**的 cell 走 `canonical`——真实 `BIGINT` 列绝不经过此路径（`SELECT 904694400000 AS x` 仍是整数）。SQLite 因 result 无类型，用 `canonicalTextIfDate(v) ?? v`：非日期文本原样保留（**关键**：`?? v` 不能漏，否则每个非日期列都被置 null）。
- 三引擎 `run()` 现在对同一 naive 日期都返回 `1998-09-02`，比较器和 UI 表格自然一致。

**验证**：
- `test/date-normalize.test.mjs` 16 断言全过（type-id 映射、三载体归一、TZ 无关性、NaN/负 epoch/小数秒、`kindFromText` 拒绝 `'42'`/`'1234'`/`'Acme, Inc'`、非日期 cell 保留原值），挂进 CI 的纯测试段 + `test:unit`。
- 真引擎探针（本机 duckdb-node-blocking + PGlite + sqlite-wasm）：`DATE '1998-09-02'` 三引擎 `canonical` 后**同一文本** `1998-09-02`；`TIMESTAMP '...03:04:05'` 三引擎同一文本。修复前 `cellsEqual(duck,sql)`/`cellsEqual(pg,sql)`=false，修复后三引擎 equal。
- 完整三引擎同场（含 DuckDB browser bundle）由 CI 的 `test/arena-test.mjs` 新加的 **date column projection** 用例守门（投影裸 `l_shipdate`，任一引擎编码分叉即 `exit(1)`），`test/arena-matrix.mjs` 同步加 `date-projection` 诊断项。

## 已修复 P2 工程门禁（2026-11-20）

- **M1（CRITICAL）`src/warehouse.js` Web Lock 泄漏** — `destroy()` 在 leader 初始化期间（32MB wasm 下载/open 阶段）调用时，旧代码的 lock callback 会落到 `await lockRelease` 永不返回 → 该名字上的 Web Lock 永久泄漏，其它标签页再也拿不到 leader。修法：加 `closing` 标志，`destroy()` 先置位；lock callback 在 `await ready` 后检查 `closing` 直接 return 释放锁（不再安装新的 lockRelease），并在 `.then` 分支拆除半初始化的 db（避免 wasm 内存泄漏）；`start()` 的 client 回退分支加 `closing` 守卫避免误降为 client。配套 `test/warehouse-lock.test.mjs`（纯 Node，stub `navigator.locks` 忠实 Web-Lock 模型 + fake duckdb）：**对旧代码实测复现**——lock 泄漏、第二个 `start()` 抛 `no warehouse leader became available`（其它 tab 永远成不了 leader）；修复后 6/6 通过。已挂进 CI。
- **M10 `public/compare.js` XSS** — `render`/`renderError` 补 `escapeHtml`（与 arena.js 一致），`result.label`/`result.version`（引擎返回值，用户 SQL 可控）/错误信息不再直接拼 innerHTML。
- **M9 `test/server.mjs` 缓存** — `cache-control` 从全量 `no-store` 改为：`.wasm`/`.data`（内容稳定的 ~49MB 引擎产物）发 `public, max-age=31536000, immutable`，HTML/JS/CSV 仍 `no-store`（本地改动即时生效）。消除每次刷新重下全部 wasm 的性能杀手。
- **M8（误报，已实测证伪，不改）** — 专家称"Pages 部署产物缺 DuckDB wasm，上线即坏"。沙箱复现 `pages.yml` 的 staging 序列证明这是误判：第 57 行 `cp -r public dist/public` 时 `public/vendor` 尚不存在（`fetch-vendor.sh` 在第 59 行才创建它），所以第 60 行 `cp -r public/vendor dist/public/vendor` 的目标目录不存在，`cp -r` 把源目录整体拷成 `dist/public/vendor`，`duckdb-base.wasm` **确实在** `dist/public/vendor/`。`pages.yml` 正确，未改。

> 诚实边界：以上 C1/C2 用本机可跑的 sqlite-wasm + 真实源码模块验证了**绑定/DDL 层**；P1 比较器用 `result-compare.test.mjs` 的纯函数回归（20 断言全过、含 `isOrdered` 8 个边界用例）验证了**比较逻辑层**。完整三引擎同场 Playwright 回归（`npm run test:arena`）需 CI 或 `npm run setup` 后跑；M7 断言与 unit 测试均已 `node --check` 通过并实际执行。


---

## 一句话结论

架构方向正确（单份推断 schema 三引擎共用 + 多重集比较 + 布尔/浮点归一），README 承诺的三大陷阱基本落地。但有两类问题动摇产品根基：**(1) 数据装载在大整数场景下三引擎并不一致**（SQLite 丢精度、DuckDB INTEGER 宽度不同），"同一份数据"的前提失效；**(2) 比较器有多个会制造"假分歧"的坑**（有序并列行错位、unordered 顺序标注失效、rowKey 折叠不全、日期列三引擎三种编码）。此外 CI 的关键测试无断言、本地 dev 服务器全量 no-store 反复下载 49MB。（专家另报"Pages 部署缺 wasm 上线即崩"——经沙箱复现证伪，见 M8。）以上 C1/C2/M1/M2-M10 已全部修复并验证，详见上文"已修复"各节。

---

## CRITICAL — 动摇"同一份数据 + 同一句 SQL"根基

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| C1 | `src/engines.js:118-119` | SQLite 用 `Number(raw)` 绑定 INTEGER/DOUBLE，double 仅 53 位尾数。实测 `Number('12345678901234567')` → `12345678901234568`（精度丢失）。DuckDB/PGlite 走 `sqlLiteral` 原样传十进制字面量、存精确值。同一 17-18 位大整数 ID 在 SQLite 被舍入、另两家精确 → JOIN/GROUP BY/等值在 SQLite 悄悄给出不同结果，比较器报"分歧"，用户无法分辨是引擎差异还是装载错误。 | INTEGER/大整数绑定 BigInt（sqlite-wasm 支持 64 位绑定）或保留字符串交给 INTEGER 亲和性转换；禁止对 >2^53 的值用 `Number()`。 |
| C2 | `src/csv-schema.js:147-151`（duckdb 分支）对照 153（pglite 分支） | 同一个 `INTEGER` 在三家实际宽度不同：DuckDB INTEGER=INT32（4 字节）、PGlite 映射 BIGINT（64 位）、SQLite INTEGER=64 位。`INT_RE`（第 12 行）允许 18 位数字，任何 >2^31≈21 亿的 ID 列在 DuckDB INSERT 即整数溢出报错、另两家正常。"一次推断、三家共用同一份 DDL"（README:57）对 INTEGER 不成立。 | duckdb 分支把 INTEGER 也映射为 BIGINT，与 pglite 对齐（18 位内安全，顺带消除 18 位无符号越界 int64 的边角）。 |

> C1 + C2 同源：单份 schema 分发没考虑引擎整数宽度。这两点是"arena"最伤的两个点，因为它们让分歧信号本身不可信。

---

## MAJOR

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| M1 | `src/warehouse.js:118-153` vs `341-354` | Web Lock 生命周期竞态：`start()` 的 lock callback 先 `await #openLeader()` 再 `await lockRelease`。若用户在 leader 初始化（32MB wasm 下载/OPFS 打开）期间调 `destroy()`，`lockRelease` 此刻仍为 `null`（`lockRelease?.()` 空操作），而 callback 随后继续执行把 `lockRelease` 设为新 resolve；但 `destroy()` 已把 `role` 置 `closed`，之后无人再调 `destroy()` → **lock callback 永不返回，该名字上的 Web Lock 永久泄漏**，其它标签页再也拿不到 leader，需刷新本 tab 才恢复。 | `destroy()` 与 lock callback 的释放统一收口：用一个"已释放"标志 + 在 `start()` 暴露的 settle 处兜底 resolve；或把 `lockRelease` 赋值提到 `#openLeader()` 之前。 |
| M2 | `src/result-compare.js:143-144` | ordered 模式纯位置配对：`ORDER BY` 排序键有并列（tie）时各引擎对并列行的物理顺序不保证，位置比较把并列行对错、报"结果分歧"。实测 `{A,5},{B,5},{C,9}` vs `{B,5},{A,5},{C,9}`（均 `ORDER BY s`）→ `equal=false, firstDiff g:'A' vs 'B'`。GROUP BY 查询里并列聚合值极常见，会造成高频假分歧。 | ordered 模式先按 key 桶配对（复用 unordered 逻辑）；多重集不等才报值分歧，多重集相等而序列不等降级为"顺序差异"。 |
| M3 | `src/result-compare.js:133-135` | 无 ORDER BY 时 `orderMatches` 用排序后 key 比较，恒为 true（实测 `[1,2] vs [2,1]` → `orderMatches=true`）。README:61 承诺"顺序差异单独标注、不算结果分歧"未实现：无序查询的顺序差异永不被标注，`public/arena.js:107` 的"值一致·顺序不同"药丸在 unordered 分支不可达。 | unordered 模式下 `orderMatches` 应比较未排序的原始 key 序列（true=恰好同序），等值判断保持多重集口径。 |
| M4 | `src/result-compare.js:88-95`（rowKey） | rowKey 只折叠 `boolean` 类型（`#1`/`#0`），不折叠数值 0/1 与字符串 `'1'`/`'0'`（注释第 84-86 行声称会折叠）。SQLite 无布尔类型，BOOLEAN 列按 TEXT 亲和存的是文本 `'1'`/`'0'`。行序不同 + 含布尔列时 key 桶匹配全部落空、位置兜底错行配对 → 假分歧。实测 `[{true,'a'},{false,'b'}]` vs `[{0,'b'},{1,'a'}]` → `equal=false, firstDiff b:'true' vs '0'`，同序反而 equal=true，行为自相矛盾。 | rowKey 对数值/字符串复用 `cellsEqual` 里 `asBool` 的折叠逻辑（0/1/'0'/'1'/'true'/'false' 统一为 #0/#1）。 |
| M5 | `src/result-compare.js:202-204`（isOrdered） | `isOrdered` 用 `/\border\s+by\b/i` 全文匹配：子查询/CTE 里的 ORDER BY 会把外层无 ORDER BY 的查询误判为 ordered（derived table + LIMIT 是极常见写法），外层顺序未保证却按位置比较；字符串字面量含 'order by' 同样误判。实测 `isOrdered("SELECT * FROM (SELECT * FROM t ORDER BY a)")` = true。 | 只检测顶层 ORDER BY：剥离字符串字面量/注释后，取最后一个右括号之后的文本再匹配。 |
| M6 | `src/result-compare.js:30` + `34-37` | duckdb-wasm 对 DATE/TIMESTAMP 列若返回 JS Date 对象，`normCell` 折成 epoch 毫秒 number，而 PGlite/SQLite 返回 `'YYYY-MM-DD'` 字符串（kind=string）→ `cellsEqual` 跨 kind 落到 `String()` 比较必然不等：任何把日期列投影出来的查询都报假分歧。`arena-matrix.mjs` 的 date 用例只返回 `count(*)` 恰好绕开；需线上一次验证 duckdb-wasm 实际返回类型。 | Date 分支按列语义格式化为 ISO 文本（date→`YYYY-MM-DD`，timestamp→`YYYY-MM-DD HH:MM:SS[.fff]`）再比较，与 PG/SQLite 文本表示对齐。 |
| M7 | `test/arena-test.mjs:28-34` | CI 里名为"Engines agree on a four-table join"的步骤**没有任何断言**：引擎报错、结果分歧都只 `console.log`，进程仍以 0 退出。CI 实际只证明"页面能加载、引擎不崩"，而非三引擎结果一致——这是本项目最该守的门。 | 对每个引擎断言 `r.ok===true`、`r.compare.equal===true`（及 `orderMatches`），失败 `process.exit(1)` 并打印首个差异 cell。 |
| M8 | `.github/workflows/pages.yml:53-74`（对照 `scripts/fetch-vendor.sh`） | Pages 部署产物缺 DuckDB wasm，上线即坏：staging 在 `fetch-vendor` 之前就 `cp -r public dist/public`，之后只补拷 `dist/public/vendor`，但 `duckdb-base.wasm` 从未进入 `dist/public/vendor`。仓库转 public 首次运行三页加载 `duckdb-browser.mjs` 后 404 崩。CI 跑本地仓库布局，测不出。 | 把 `fetch-vendor` 提到 staging 之前，或 staging 后显式确认 `dist/public/vendor/duckdb-base.wasm` 存在（加一步校验）。 |
| M9 | `test/server.mjs:59` | 本地 lab 服务器对所有响应（含 32MB duckdb-base.wasm、pglite.wasm、CSV 数据）统一 `cache-control: no-store`，每次刷新/重启都重新下载全部 ~49MB wasm——本地开发最大的性能杀手。Pages 侧 wasm 也无 gzip/版本号。 | 对 `.wasm`/`.data` 发长缓存（`public, max-age=31536000, immutable`）+ ETag 或文件名带 hash；HTML/JS 维持 no-store。 |
| M10 | `public/compare.js`（render/renderError 的 innerHTML） | `compare.js` 全程无 `escapeHtml`（arena.js:124-126 有），`result.version` 等引擎返回值直接拼进 innerHTML。用户自定义 SQL 返回的字符串若含 `<`/`<script>` 会执行。 | 为 compare.js 补一个与 arena.js 相同的 escapeHtml 并用于所有插值。 |

---

## MINOR

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| m1 | `.github/workflows/ci.yml:43` + `pages.yml:40` | CI 从 GitHub Releases 下载 duckdb CLI v2.0.0，`curl \| tar -xz` 只钉版本号、无 SHA-256/签名校验。 | 下载后比对官方 release 附带的 sha256sum。 |
| m2 | `package.json:23` + `README:155` | `@duckdb/duckdb-wasm` 钉在 `-dev` 预发布（`1.33.1-dev118.0`），而 README 声称必须钉 1.32.0 或 @next(≥dev61)——版本策略自相矛盾；其余运行时依赖用 `^` 浮动（浏览器内引擎版本漂移会改变比较结果，本地不可复现）。 | 对 benchmark 工具建议四个运行时依赖全钉精确版本（去掉 `^`），README 与 package.json 对齐；至少写明"必须 `npm ci`，禁止裸 `npm install`"。 |
| m3 | `README.md:59` vs `src/result-compare.js:42` | README 只写"相对容差 1e-9"，但代码还有 `ABS_TOL=1e-6`（小数差到 1e-7 也判相等，相对差异可高达 1e9 倍）——文档与实现的容差语义不一致。 | README 同时写明绝对容差 1e-6，或把绝对容差降到与相对容差自洽的量级。 |
| m4 | `src/csv-schema.js:115/132`（sampleRows=2000）+ `176-177` | 类型推断只看前 2000 行样本；第 2001 行起的脏值（整数列混入 'abc'）在 DuckDB/PGlite 被 `sqlLiteral` 静默转 NULL，而 SQLite 路径 `Number('abc')=NaN`（sqlite-wasm 对 NaN 绑定行为未定义）——同一条脏数据三家落库值不同且无警告，静默数据损坏。 | 对全部行做验证扫描，违例把该列降级 TEXT 或显式报错，不靠 `sqlLiteral` 的 NULL 兜底。 |
| m5 | `src/csv-schema.js:68` | 末尾 filter `r.length>1 \|\| r[0]!==''` 会把单列 CSV 中值为空字符串的合法数据行整行丢弃：一列文件里空值行被静默删除，行数与源文件不符。 | 用"是否消费过输入字符"标记行来源，只丢弃文件末尾的假空行，保留真实数据行。 |
| m6 | `src/engines.js:106` | SQLite 分支 DDL：列名有转义（105 行 `replaceAll('"','""')`），但 `DROP/CREATE/INSERT` 的**表名**直接拼 `"${ds.name}"` 不转义（DuckDB/PGlite 用 `quotePg`）。当前 arena.js 把表名净化成 `[A-Za-z0-9_]` 所以未爆，属潜伏点。 | SQLite 分支表名同样 `replaceAll('"','""')`，消除对 UI 层净化的隐式依赖。 |
| m7 | `src/result-compare.js:57` 与 `177-181` | NaN：`cellsEqual(NaN,NaN)=false`（两个引擎都算出 NaN 时报"分歧"）；配对计算 `Math.abs(NaN-q)/denom=NaN` → `Math.max(0,NaN)=NaN`，`report.maxRelDiff` 被污染成 NaN 传给 UI。 | 两个 NaN 视为相等；`maxRelDiff` 累加前加 `Number.isFinite` 守卫。 |
| m8 | `src/result-compare.js:92`（rowKey `toPrecision(12)`） | 行 key 用 12 位有效数字，而容差是相对 1e-9：key 列本身带 ~1e-10 级求和噪声时，两引擎 key 字符串在第 11 位分叉，桶匹配落空交给位置兜底；有重复行时兜底可能错行配对。 | key 数值按容差舍入（`toPrecision(10)` 或 round 到 1e-9 网格）再入桶。 |
| m9 | `test/upload-check.mjs` + `test/server.mjs:14` + `README:139` | 端口默认值三处不一致：upload-check.mjs 硬编码 `127.0.0.1:8791`（不读 PORT/BASE，与 arena-test.mjs 不同），server.mjs 默认 8765。CI 靠 `PORT: 8791` 强行对齐；本地按 README:139 `node test/server.mjs &`（不带 env）server 起在 8765，`npm run test:upload` 打 8791 → 连接拒绝。 | server.mjs 默认端口改 8791；upload-check.mjs 改成 arena-test.mjs 的 `PORT/BASE` env 模式；README:139 命令补 `PORT=8791`。 |
| m10 | `test/mobile-compare.mjs:11` | `waitForFunction(() => window.__wh === false \|\| true)` 恒真，无意义等待。 | 改为等待该页真实就绪信号（如 `#run` 按钮 enabled），或删掉。 |

---

## 做得好的

1. **核心架构正确**：类型一次推断、三家共用同一份 DDL（`inferSchema` + `ddlType` 分引擎映射 + `engines.js` 各 `load` 只消费共享 schema），从源头消除 README 里 `'9'>'100'` 那种文本/数值比较不一致这一最大假分歧来源。
2. **比较器报结构不报布尔**：返回 `firstDiff`（列名+两侧原值）、`maxRelDiff`、`missingColumns`、rowCount 对比，UI 可直接展示首个差异单元格，排障体验好。
3. **浮点容差双条件**（绝对 1e-6 或相对 1e-9）+ 桶配对/位置兜底，刻意把浮点尾差表现为"值差异"而非"行缺失"，意图明确。
4. **布尔归一完整**：`cellsEqual.asBool` 覆盖 boolean / 0-1 / `'true|t|1'` 三种表示，正确处理 SQLite 无布尔类型的现实（rowKey 侧没跟上，见 M4）。
5. **CSV 解析是完整 RFC 4180 状态机**：BOM 剥离、引号内逗号/换行、`''` 转义，含 fixtures 的 `"Acme, Inc"`、`"Gamma ""G"" Ltd"` 用例。
6. **降级路径完备**：`capabilities()` 在 insecure context（LAN 纯 http）自动退化为内存模式并明确告知"刷新即丢、无法多标签页"，LAN 自动切 https 自签恢复 OPFS/Web Locks；`test/server.mjs` 走公开 API 断言而非刮 DOM。

---

## 修复优先级建议

1. **P0（根基）**：C1 SQLite 大整数绑定、C2 DuckDB INTEGER→BIGINT 宽度 —— 先把"同一份数据"修到三家真的一致。
2. **P1（比较器可信度）**：M2 ordered 并列行桶配对、M3 unordered `orderMatches`、M4 rowKey 折叠 0/1/'0'/'1'、M5 `isOrdered` 顶层检测、M6 日期 Date 对象格式对齐。
3. **P2（质量门禁）**：M1 warehouse.js 锁生命周期、M7 CI 加真断言、M8 Pages 部署补 wasm、M9 缓存、M10 compare.js XSS。
4. **P3（其余 MINOR）**：按表逐条清。

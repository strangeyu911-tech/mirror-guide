# 读者批注后端（Cloudflare Worker）

给 <https://mirror.strangeyu.xyz/> 提供批注的存储与转发：读者零账号提交 → 落 KV → 用维护者的凭据代发到私有仓库的聚合 issue。

```
读者浏览器（零 GitHub 账号）
   │  POST https://anno.strangeyu.xyz/api/anno
   ▼
Worker（本目录）
   ├─ origin 白名单校验
   ├─ 反自动化：蜜罐字段(hp) + 提交耗时下限(t0/MIN_FILL_MS)
   ├─ 字段校验（长度 / 链接数 / 偏移范围 / 页面白名单）
   ├─ 限流（ip_hash：10 条/小时、50 条/天，KV 计数器带 TTL）
   ├─ 写 KV（anno:<id>，24h 幂等去重靠它）
   ├─ Turnstile 人机验证（可选，未配则跳过）
   └─ 用维护者的 token 代发 comment ──► 私有仓库 mirror-guide-feedback 的聚合 issue #1
```

**所有 comment 的作者都是维护者本人**，读者在 GitHub 上不出场；区分读者看 comment 正文里的「读者」那一行。

---

## 当前状态（2026-10-13 实测）

| 项                  | 状态                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Worker 部署          | ✅ 已上线 `https://anno.strangeyu.xyz`                                                                                       |
| 健康检查               | ✅ `GET /api/health` → `{"ok":true,"store":"kv","turnstile":false,"github":true}`                                         |
| 自定义域               | ✅ `anno.strangeyu.xyz` 已绑定                                                                                               |
| KV 命名空间            | ✅ `mirror-guide-anno`（id `157f5a2bc56b417e93f5fb09d08cc799`）                                                             |
| 私有反馈仓库             | ✅ `strangeyu911-tech/mirror-guide-feedback`（visibility=private），issue #1 已 pin，4 个标签 `new`/`accepted`/`rejected`/`fixed` |
| `GITHUB_TOKEN`     | ✅ 已写入 secret（用的是本机 `gh auth token`，**不需要另建 PAT**）                                                                        |
| `HASH_SALT`        | ✅ 已写入 secret                                                                                                             |
| `TURNSTILE_SECRET` | ⚪️ 未配置，`turnstile:false`（不阻塞：蜜罐 + 提交耗时 + 限流已实测生效）                                                                        |
| 前端接入               | ✅ 两页各一行 `<script src="annotate.js" defer></script>`（`index.html` / `patch.html`）                                          |
| 单元测试               | ✅ `node test/unit.mjs` → 37 通过 / 0 失败                                                                                    |

### 为什么用 KV 而不是 D1

批注是"写得少、读得极少、只按 id 取"的场景，KV 足够，且省掉建表与迁移。  
更实际的原因：现有 Cloudflare token **没有 D1 权限**（建库返回 401），而 KV 权限本来就有。  
若日后确实要换 D1，改造点在 `worker/src/index.js` 里 `env.KV` 的四处调用。

---

## 部署与配置命令

在 `worker/` 目录下执行（本机 wrangler 跑不起来，缺 `@cloudflare/workerd-windows-64`，连 `--help` 都崩，所以走 `deploy/deploy.mjs` 直接复刻 CF 原生 API）。

```bash
# 部署代码（bindings 带全：KV 绑定 + 全部 vars）
CF_TOKEN=<token> node deploy/deploy.mjs

# 只补写 / 轮换 secret
CF_TOKEN=<token> \
GITHUB_TOKEN=<gh 的 token> \
HASH_SALT=<随便一串随机字符> \
node deploy/deploy.mjs --secrets
# 需要 Turnstile 时再加一行 TURNSTILE_SECRET=<turnstile secret>

# 导出全部批注做备份
CF_TOKEN=<token> node deploy/deploy.mjs --dump 备份.json

# 换一个 KV 命名空间
CF_TOKEN=<token> node deploy/deploy.mjs --kv=<namespace_id>
```

> ⚠️ `PUT /workers/scripts/{name}` 是**全量替换**：`bindings` 必须一次带全（KV + 所有 vars），  
> 漏一个就会**静默抹掉**它。`deploy.mjs` 已经把全部 vars 写在 `VARS` 里，改配置改那里，别在后台点。

### 清理 KV（联调后必做）

```bash
CF_TOKEN_FILE=<token文件路径> node deploy/kv-clean.mjs           # 只列出
CF_TOKEN_FILE=<token文件路径> node deploy/kv-clean.mjs --apply   # 真删
```

默认 dry-run。token 只从环境变量读（`CF_TOKEN` 或 `CF_TOKEN_FILE`），**不落盘、不入库**。

---

## 验收清单

- [x] `curl https://anno.strangeyu.xyz/api/health` → `{"ok":true,...,"store":"kv",...}`
- [x] 页面上划一段字、写批注 → 私有仓库 issue #1 出现新 comment，正文里读者原文在代码块内
- [x] 幂等：同 id 重发 → `{"ok":true,"deduped":true}`，不重复落 comment
- [x] 蜜罐字段填了内容 → 400 `rejected`
- [x] 提交过快（早于 `MIN_FILL_MS`）→ 400 `too_fast`
- [x] 正文超长 → 400 `body_too_long`
- [x] 超过小时限额 → 429（KV 计数改大后实测）
- [x] 非白名单 origin → 不回 `Access-Control-Allow-Origin`
- [x] `mirror-guide` 公开仓库里搜不到任何读者批注内容
- [ ] 不带 Turnstile token 直调接口 → 403（**未启用 Turnstile，此项暂不适用**）

---

## 日常操作

**看新反馈**：直接看私有仓库的 issue #1（有 pin），每条 comment 就是一条批注；  
处理完给 comment 加「已采纳/不采纳」的回复，或在该 issue 上打标签。

**查数据**：`CF_TOKEN_FILE=<path> node deploy/kv-clean.mjs` 会列出全部 key（`anno:<id>`）；  
单条内容用 `node deploy/deploy.mjs --dump 备份.json` 整体导出。

**代发失败的补发**：KV 里存着 `gh` 字段记录代发结果；`gh.ok=false` 的那些说明 comment 没发出去，  
数据仍在 KV 里，可手动补到 issue。

---

## 本地测试

```bash
node test/unit.mjs     # 37 项纯逻辑单测：fence 围栏递进、validate 全分支、蜜罐与提交耗时、防注入、昵称与联系方式
```

---

## 前端接入（annotate.js）

页面只多一行 `<script src="annotate.js" defer></script>`，模块自己注入样式与 UI。
`index.html` 与 `patch.html` 都已接入。

### 两页用的是两套章节模型

锚点必须落在一个"章节"里（`sec + 章节内文本偏移 + 原片段 + 前后 40 字上下文`），
所以两页各自需要一种模型。`buildIndex()` 一次遍历同时支持两者：

| 页面          | 模型  | id 挂在哪                              | 区间算法                          |
| ----------- | --- | ---------------------------------- | ----------------------------- |
| `index.html` | 标题型 | `h1~h6`（`s00`/`s10`/`s11`…`s99`）    | 到下一个**同级或更高级**标题为止            |
| `patch.html` | 容器型 | 包住整块内容的元素（41 张 `.pcard` 的 `pNN`） | **整棵子树**都归它                   |

两条容易写错的规则：

1. **容器内部的无 id 小标题不能打断容器归属。** 卡片里还有 `<h3>`（卡片标题），
   它必须继续算在这张卡里，否则卡片正文会被切成两截、锚点上下文全乱。
2. **离开容器子树后作用域要立刻失效。** 否则最后一张卡片之后的页脚、致谢、免责声明
   会被并入 `p41`，读者能对页脚划线。

实测边界（本地 `__anno.resolve` 验证）：`p41` 能定位到自己的正文、**定位不到**页脚与致谢；
`p01` 定位不到它上面的"情形 A/B"板块。

id 的命名规则是 `HEAD_ID_RE = /^s[0-9]/`、`CARD_ID_RE = /^p[0-9]{1,3}$/`，
其余 id（`#ref1`、`#shouzhu-cards`…）不会被当成章节。

### 面板里显示的是标题，不是 `p20`

`secLabel(id)` 优先读元素上的 `data-anno-label`，否则取该章节元素自己（或其后代）
第一个 `h1~h6` 的文字，截 26 字。所以卡片在面板里显示成
「家庭资产按"自住 / 投资 / 现金等价物"三分」而不是 `p20`。

### 批注落在被筛掉的卡片上

补丁页有筛选，被筛掉的卡片是 `display:none` —— 这时 `getBoundingClientRect()` 全是 0，
照着跳会跳到页面顶部。现在会拦住并提示「先点『清空筛选』」。

### 补 `patch.html` 卡片 id 的工具

`tools/add-card-ids.cjs`（幂等，`--check` 只报告）。patch.html 如果重生成，跑一次即可：

```bash
node tools/add-card-ids.cjs patch.html
```

**踩过的两个坑，改前端时别踩回去：**

1. **z-index 必须高于站点自身最高层。** 站点有 `#progress`(999)、`#toc`(950)、`div.bottomnav`(800)，  
   且目录栏与底栏都是**不透明**的。批注层早年用 70~90，结果整个 UI 被目录栏盖住，读者点不到。  
   现在统一 1000/1001/1002/1003。
2. **悬浮按钮的落点要实测避让。** `placeRoot()` 从右下角逐格往上探，找到第一个"按钮下沿下方  
   没有不透明固定层"的位置，写进 `--anno-safe-b`。判定"遮挡"时必须  
   **扫完整个堆叠**（底栏是 sticky 容器套 relative 链接，只看栈顶会漏判），  
   并且**只认视觉不透明的层**（浏览器扩展常注入 `rgba(0,0,0,0)` 的整屏透明层，  
   按它避让会把按钮顶到页面中间）。

---

## 安全约定（改代码时别破坏）

1. `GITHUB_TOKEN` 只出现在 Worker secret 里，**任何情况下都不返回给前端**
2. 读者原文（划中片段与批注正文）必须经 `fence()` 用代码块包裹后才写进 comment —— 否则 `#12` / `fixes #1` / `@某人` / `![](url)` 会被 GitHub 渲染成关联、提及、外链
3. 不存 IP 原文、不存账号标识；`ip_hash` 加 `HASH_SALT` 后再 sha256
4. `ALLOWED_PAGES` 是白名单，别改成通配
5. `deploy.mjs` / `kv-clean.mjs` 里的 token **只从环境变量读**，别改成读同目录文件（会误提交）

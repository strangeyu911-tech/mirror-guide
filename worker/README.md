# 读者批注后端（Cloudflare Worker）

给 <https://mirror.strangeyu.xyz/> 提供批注的存储与转发：读者零账号提交 → 落 D1 → 代发到私有仓库的聚合 issue。

```
读者浏览器（零 GitHub 账号）
   │  POST https://anno.strangeyu.xyz/api/anno
   ▼
Worker（本目录）
   ├─ origin 白名单校验
   ├─ 字段校验（长度 / 链接数 / 偏移范围 / 页面白名单）
   ├─ Turnstile 人机验证
   ├─ 限流（ip_hash + device_hash：10 条/小时、50 条/天）
   ├─ 写 D1（annotations）
   └─ 用维护者的 token 代发 comment ──► 私有仓库 mirror-guide-feedback 的聚合 issue
```

**所有 comment 的作者都是维护者本人**，读者在 GitHub 上不出场；区分读者看 comment 正文里的「读者」那一行。

---

## 当前状态

| 项 | 状态 |
|---|---|
| Worker 部署 | ✅ 已上线 `https://anno.strangeyu.xyz` |
| 健康检查 | ✅ `GET /api/health` → `{"ok":true}` |
| 自定义域 | ✅ `anno.strangeyu.xyz` 已绑定 |
| 私有反馈仓库 | ✅ `strangeyu911-tech/mirror-guide-feedback`，issue #1 已 pin |
| D1 数据库 | ⏳ 待建（现有 CF token 无 D1 权限） |
| `GITHUB_TOKEN` | ⏳ 待写入 |
| `TURNSTILE_SECRET` | ⏳ 待写入（未配置时校验会被跳过，**上线前必须补**） |

---

## 还需要你做的三件事

### ① 给 Cloudflare token 补 D1 权限

去 <https://dash.cloudflare.com/profile/api-tokens> → 找到现有 token（id `d5d5175e722e4f73637e2b284cf566fd`）→ Edit → 权限里加上：

- **Account → D1 → Edit**

保存即可（token 值不变）。或者新建一个 token，把 `CF_TOKEN` 换成新的。

### ② 建 GitHub 细粒度 PAT

<https://github.com/settings/personal-access-tokens/new>

- Token name：随意，如 `mirror-guide-anno`
- Expiration：**1 年**（到期要换，日历里记一笔）
- Repository access：**Only select repositories** → 只勾 **`mirror-guide-feedback`**
- Permissions → Repository permissions → **Issues: Read and write**（其他一律不给）
- 生成后复制 `github_pat_...`（只显示一次）

### ③ 建 Turnstile widget

<https://dash.cloudflare.com/?to=/:account/turnstile> → Add widget

- Widget name：`mirror-guide-anno`
- Hostnames：加 `mirror.strangeyu.xyz`
- Widget Mode：**Invisible**
- 建完拿两个值：**Site Key**（公开，填到前端）和 **Secret Key**（私密，填到 Worker）

---

## 部署与配置命令

在 `worker/` 目录下执行。先建库、建表：

```bash
# 建 D1 数据库，记下返回的 uuid
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/320630a19eed9c18dc9371dd71d6f288/d1/database" \
  -d '{"name":"mirror-guide-anno"}'

# 建表（可重复执行）
CF_TOKEN=<token> node deploy/deploy.mjs --schema --d1=<database_id>
```

再部署脚本（带上 D1 绑定）：

```bash
CF_TOKEN=<token> D1_ID=<database_id> node deploy/deploy.mjs
```

最后写入 secret：

```bash
CF_TOKEN=<token> \
GITHUB_TOKEN=<github_pat_...> \
TURNSTILE_SECRET=<turnstile secret> \
HASH_SALT=<随便一串随机字符> \
node deploy/deploy.mjs --secrets
```

> `PUT /workers/scripts/{name}` 是**全量替换**，bindings 一次带全；`deploy.mjs` 已经把全部 vars 写在 `VARS` 里，改配置时改那里而不是在后台点。

---

## 验收清单

- [ ] `curl https://anno.strangeyu.xyz/api/health` → `{"ok":true,...,"turnstile":true}`
- [ ] 页面上划一段字、写批注 → 私有仓库 issue #1 出现新 comment，正文里读者原文在代码块内
- [ ] 断网提交 → 页面上立即出现批注，面板显示「待发送」；恢复网络后自动补发、变干净
- [ ] 连发 11 条 → 第 11 条返回 429，面板不再无限重试（退避 10 分钟）
- [ ] 不带 Turnstile token 直调接口 → 403
- [ ] 从非白名单 origin 调用 → 403
- [ ] `mirror-guide` 公开仓库里搜不到任何读者批注内容

---

## 日常操作

**看新反馈**：直接看私有仓库的 issue #1（有 pin），每条 comment 就是一条批注；打完标签 `accepted`/`rejected`，改完标 `fixed`。

**查数据 / 改状态**：

```bash
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/320630a19eed9c18dc9371dd71d6f288/d1/database/<database_id>/query" \
  -d '{"sql":"SELECT id,page,sec,status,created_at,substr(body,1,40) FROM annotations ORDER BY created_at DESC LIMIT 20"}'
```

**代发失败的补发**：`gh_error IS NOT NULL` 的那些，说明 comment 没发出去，可在 GitHub 侧手动补，或先不管（数据已在库里）。

---

## 本地测试

```bash
node test/unit.mjs     # 30 项纯逻辑单测：校验、限流边界、comment 防注入
```

---

## 安全约定（改代码时别破坏）

1. `GITHUB_TOKEN` 只出现在 Worker secret 里，**任何情况下都不返回给前端**
2. 读者原文（划中片段与批注正文）必须经 `fence()` 用代码块包裹后才写进 comment —— 否则 `#12` / `fixes #1` / `@某人` / `![](url)` 会被 GitHub 渲染成关联、提及、外链
3. 数据表不存 IP 原文、不存账号标识；`ip_hash` / `device_hash` 都加 `HASH_SALT` 后再 sha256
4. `ALLOWED_PAGES` 是白名单，别改成通配

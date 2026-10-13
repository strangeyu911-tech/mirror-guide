# 衰退时代版人生决策 skill（recession-life-guide）

让 AI 助手照《高性价比人生指南·衰退时代补丁包》回答下行周期里的具体问题：**现在要不要提前还贷、考研还是考公、能不能买房、空窗期能拖多久、社保养老金怎么交、要不要出海、要不要生孩子**。

它做的事只有一件：**先判当前在情形 A（政府持续财政对冲）还是情形 B（对冲不足）、核对五个证伪信号，再把相关补丁条目从 `patches.md` 查出来，按补丁类型与证据档排序回答**，每条注明 P 编号和《以日为镜》完整论证锚点。查不到就说查不到，不凭记忆编数字。

这是 [strangeyu911-tech/mirror-guide](https://github.com/strangeyu911-tech/mirror-guide) 里在线补丁 [《衰退时代补丁包》](https://mirror.strangeyu.xyz/patch) 的配套 skill，也是 HowToLiveBetter 官方 [life-decision-guide](https://github.com/eternity4719/HowToLiveBetter/blob/main/skills/life-decision-guide/README.md) 的**衰退期姊妹篇**——不是替代：跨周期通用的账（疫苗、低钠盐、别担保、急救、营养）请用官方 skill 查原书。

规则在 [SKILL.md](SKILL.md)，41 条语料在 [patches.md](patches.md)（与在线页逐字对应，判断时点 2026 年 10 月）。

## 装到 Claude Code

想在任何目录下都能用，把 `SKILL.md` 和语料 `patches.md` 一起复制到个人 skill 目录：

```bash
mkdir -p ~/.claude/skills/recession-life-guide && \
curl -fsSL -o ~/.claude/skills/recession-life-guide/SKILL.md "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/SKILL.md" && \
curl -fsSL -o ~/.claude/skills/recession-life-guide/patches.md "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/patches.md"
```

之后直接问「现在这行情，房贷要不要提前还」「文科研究生还值得读吗」就会触发；也可以显式说「用 recession-life-guide 回答」。

## 装到 Codex

复制到 Codex 的个人 skill 目录 `~/.agents/skills`：

```bash
mkdir -p ~/.agents/skills/recession-life-guide && \
curl -fsSL -o ~/.agents/skills/recession-life-guide/SKILL.md "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/SKILL.md" && \
curl -fsSL -o ~/.agents/skills/recession-life-guide/patches.md "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/patches.md"
```

直接问问题会按描述自动触发，也可以输入 `$recession-life-guide` 显式调用（注意是 `$` 不是 `/`）；没出现就重启一次 Codex。

## Windows（PowerShell）一键安装

```powershell
# Claude Code 用 "$env:USERPROFILE\.claude\skills"；Codex 改成 "$env:USERPROFILE\.agents\skills"
$d = "$env:USERPROFILE\.claude\skills\recession-life-guide"
New-Item -ItemType Directory -Force $d | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/SKILL.md"    -OutFile "$d\SKILL.md"
Invoke-WebRequest "https://raw.githubusercontent.com/strangeyu911-tech/mirror-guide/main/skills/recession-life-guide/patches.md" -OutFile "$d\patches.md"
```

## 语料和完整论证从哪来

- 本目录自带 `patches.md`（41 条，几十 KB），日常问答只查它就够。
- 每条背后的中日数据、学者观点、置信度与证伪逻辑在《以日为镜：衰退时代普通人生存指南（增补版）》`index.html`，浅克隆主仓库即可读：

```bash
git clone --depth 1 https://github.com/strangeyu911-tech/mirror-guide.git "${TMPDIR:-/tmp}/mrg"
```

- 在线版：补丁清单 <https://mirror.strangeyu.xyz/patch> ，完整论证 <https://mirror.strangeyu.xyz/> 。
- 取不到网络就如实说取不到，不拿记忆替代语料。

## 季度更新

41 条与情形 A / B 判断按季度随财政、物价、房地产数据滚动修订。更新在线页和 `patches.md` 即可，`SKILL.md` 里不留会跟着数据漂的数值（档位定义、五个信号、排序规则长期稳定）。本地装过的，重跑一遍上面的 `curl`（或 PowerShell）拉取最新 `patches.md`。

## 许可与归属

- 本 skill（`SKILL.md`、`patches.md`）与补丁网站以 **CC BY-NC-SA 4.0** 开源，作者 Strange，仓库 [strangeyu911-tech/mirror-guide](https://github.com/strangeyu911-tech/mirror-guide)。
- 灵感与“成本 / 收益 / 证据”框架致敬 HowToLiveBetter《高性价比人生指南》（正文 **CC BY 4.0**）：本 skill 是其**独立衍生增补**，未收录、未复制、也未改动原书任何一条正文，原书一切以其中文原文为准，不代表原作者观点。
- 内容为公开信息整理与研究观点，不构成投资、职业、医疗或法律建议。

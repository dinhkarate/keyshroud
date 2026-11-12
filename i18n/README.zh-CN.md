<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Agent 能用密钥，但永远看不到密钥。**

**让 API 密钥远离 Claude Code、Codex、Cursor、Cline、OpenCode、Gemini CLI、pi 和 omp** ——
密钥保存在你本机的加密 vault 中（需要在多台机器间共享时，也可以放在自托管的
[Vaultwarden](https://github.com/dani-garcia/vaultwarden) 或 Bitwarden 中），每个值在模型读到之前都会被遮蔽。

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

[🚀 快速开始](#快速开始) · [🔐 本地 vault](#本地-vault) · [🔄 多台机器同步](#多台机器同步) · [🔌 支持的 Agent](#支持的-agent) · [❓ 常见问题](#常见问题) · [🌐 网站](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="演示：在一台新机器上，keyshroud add 通过遮蔽的提示符把 GitHub token 存入本地 vault，keyshroud run 在命令输出中遮蔽它，scan 找出泄露到日志文件里的副本" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

命令拿到的是真实的 token，而 transcript（以及读取它的模型）看到的只有 `<redacted:GH_TOKEN>`。
（由 agent 执行命令时会自动遮蔽；在人工操作的终端里可以用 `--mask` 强制开启。）

## 为什么需要 keyshroud？

Coding agent 要做实际工作就需要凭据：`gh`、`npm publish`、云厂商的 CLI、webhook、数据库。常见的做法都不理想：

- ❌ **把密钥粘贴到聊天里** —— 它会留在 transcript、服务商的日志，以及之后的每一个上下文窗口里
- ❌ **放进 `.env`** —— agent 调试时会 `cat` 它，或者顺手把它提交进仓库
- ❌ **付费使用密钥管理服务** —— `op run` 需要 1Password 订阅，而大多数“agent vault”都是托管的 SaaS
- ❌ **使用 vault 的 MCP server** —— 大多数会把明文值直接返回给模型

**keyshroud 的解决方式：**

- ✅ **只给名字，不给值** —— agent 看到的是 `GH_TOKEN` 和 `keyshroud://GitHub token`，永远看不到 token 本身
- ✅ **输出遮蔽** —— 任何出现在 stdout/stderr 里的值都会变成 `<redacted:GH_TOKEN>`
- ✅ **无需任何配置** —— 一个加密的 vault 文件，密钥存在操作系统的钥匙串里；不需要账号，也不需要服务器
- ✅ **需要时再同步** —— 跑在 $5 VPS 或树莓派上的 Vaultwarden，或者 Bitwarden，供多台机器使用
- ✅ **免费** —— MIT 许可，没有遥测

## 支持的 Agent

| Agent | 安装方式 | 提供的功能 |
|---|---|---|
| **Claude Code** | [插件](#claude-code) | SessionStart + PostToolUse 遮蔽 hook、skill |
| **pi / omp** | [`pi install npm:keyshroud`](../README.md#pi--omp) | 环境变量注入、`tool_result` 遮蔽（失败的调用也包括在内）、`/secret` |
| **Codex, OpenCode, Gemini CLI, Cursor agent** | [`npx skills add dinhkarate/keyshroud`](../README.md#other-agents-with-a-shell) | skill + 输出已遮蔽的 CLI |
| **Claude Desktop、仅聊天的客户端** | [`mcpServers` JSON](#任意-mcp-客户端) | 输出已遮蔽的 MCP 工具 |
| **任意 shell 或 CI** | `keyshroud run -- <cmd>` | 环境变量注入 + 输出遮蔽 |

## 快速开始

**环境要求：** Node.js ≥ 18.19。除此之外什么都不需要：没有账号，没有服务器。

```bash
npm install -g keyshroud

# 1. 存入一个密钥 —— 在遮蔽的提示符中输入，不会回显。
#    第一个密钥会创建本地 vault。
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. 使用
keyshroud run -- gh auth status
keyshroud run -- claude          # 启动 agent，所有已绑定的密钥都可用

# 3. 检查所有配置
keyshroud doctor
```

没有终端时（例如 agent 的 shell），`add` 会在桌面上弹出隐藏输入的对话框，agent 可以启动命令，你只需粘贴。
已有 `.env`？先 `keyshroud import`（预演，只列名称），再 `keyshroud import --yes` → `.env.refs`。

### 本地 vault

`~/.config/keyshroud/vault.json` 保存所有条目，用一个随机的 256 位密钥以 AES-256-GCM 加密（条目名称也会加密）。
密钥存放的位置取决于机器：

| 机器 | 密钥 | 解锁 |
|---|---|---|
| macOS | 登录钥匙串，条目 `keyshroud-vault-<id>` | 不需要 |
| 有桌面钥匙环和 systemd 的 Linux | Secret Service（`secret-tool`；用 `busctl` 检测） | 不需要 |
| Windows | DPAPI，绑定你的 Windows 账户 | 不需要 |
| Docker、服务器、钥匙环被锁定的 SSH 会话、没有 systemd 的 Linux | 由口令派生（scrypt） | `keyshroud unlock`；会话 30 分钟后结束 |

想在任何机器上都被询问口令，可以在终端里用 `KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock` 创建 vault
（输入两次，至少 12 个字符）。丢失密钥或忘记口令都无法恢复，而且 vault 只属于一台机器；需要备份或多台机器时，请使用 Vaultwarden 或 Bitwarden。

### 多台机器同步

- **自建 Vaultwarden**（免费，用你自己的服务器）：按 [examples/vaultwarden](../examples/vaultwarden#readme) 操作——
  Docker Compose + Caddy 自动 HTTPS，从空白 VPS 一直到 `keyshroud doctor`，并包含备份与加固（英文指南）。
- **Bitwarden 云**（免费账号，无需服务器）：在 [bitwarden.com](https://bitwarden.com) 注册，
  并跳过下面的 `bw config server`（欧盟账号：`bw config server https://vault.bitwarden.eu`）。

```bash
npm install -g @bitwarden/cli

# 1. 让 bw 指向你的服务器，并登录一次
bw config server https://vault.example.com
bw login

# 2. 之后新条目存入 Vaultwarden（keyshroud:// 条目照常可用）
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend

# 3. 解锁 30 分钟（询问主密码；keyshroud 不保存任何内容）
keyshroud unlock
```

用过 keyshroud 0.7 的机器（`bw` 已登录、有 keyshroud 的文件，或钥匙串里有主密码）会继续以 Vaultwarden 为默认，无需任何操作。
`keyshroud://…` 和 `bw://…` 引用可以同时使用。

可选：把 `vaultwarden-api-client-id` / `vaultwarden-api-client-secret`（在
*Settings → Security → Keys → API key* 中获取）也存进钥匙串，这样 `bw` 登录过期（logged out）时
keyshroud 会自动重新登录；会话结束后仍需输入 master password。

### Claude Code

先安装 CLI，再安装插件（遮蔽 hook + skill）：

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

**限制**：命令**失败**时，Claude Code 触发的是 `PostToolUseFailure`，它无法改写输出。
因此 skill 和会话上下文会要求 Claude 通过 `keyshroud run`（或 `secrets_run`）运行所有用到密钥的命令 —— 它在进程内部完成遮蔽，与退出码无关。

### 任意 MCP 客户端

Codex、Cursor、Claude Desktop、Cline、Gemini CLI，以及其他任何通过 stdio 使用 MCP 的客户端：

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Codex：`codex mcp add keyshroud -- keyshroud mcp`。非交互的 `codex exec` 会拒绝需要审批的 MCP 调用，需要显式放行 keyshroud 的工具：

```toml
# ~/.codex/config.toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```
OpenCode：`opencode mcp add keyshroud -- keyshroud mcp`。

提供的工具：`secrets_list`、`secrets_run`、`secrets_request`、`vault_status`。没有任何工具会返回密钥的值。

## 常见问题

**一定要用 Vaultwarden 吗？** 不必。默认情况下密钥保存在你本机的一个加密文件里。Vaultwarden（或官方的 Bitwarden 云服务）是可选的，用于在多台机器上使用同一批密钥，或在服务器上保留一份备份。

**密钥会离开我的机器吗？** 使用本地 vault 时不会。使用 Vaultwarden 或 Bitwarden 时，只在 `bw` 和你的服务器之间传输。keyshroud 没有自己的后端，也不发送任何遥测；值只会进入你所运行命令的环境变量。

**我在用 keyshroud 0.7，有什么变化？** 没有变化：有 `bw` 登录、keyshroud 的文件、auth.json 里的 `bw://` 或 `!bw` 条目、`BW_SESSION`，或钥匙串里有主密码的机器，会继续使用 Vaultwarden，并把这个选择写入 `~/.config/keyshroud/backend`。

**agent 还能使用这个密钥吗？** 能。命令拿到的是真实的值，被遮蔽的只是模型读到的文本。

**这是沙箱吗？** 不是。它防的是*意外*泄露。恶意的或被提示注入（prompt injection）的 agent 仍然可以把它能用的值外传 —— 参见[安全模型](../README.md#security-model)。

**为什么不直接把 `.env` 加进 `.gitignore`？** 那只能阻止提交，挡不住读取。agent 调试时会读 `.env`，而它读到的内容都会发给模型服务商。

**支持 Windows 吗？** 支持，已在 Windows 10 + Node 22 上测试：本地 vault 用 DPAPI 保存密钥，绑定你的 Windows 账户。使用 Vaultwarden 时，解锁对话框是一个小的 PowerShell 窗口，会话同样 30 分钟后结束；Windows 上没有存放 master password 的钥匙串，keyshroud 每次都会询问。详见[英文 FAQ](../README.md#faq)。

**谁能打开本地 vault？** 以你的身份运行的任何程序（包括 agent）都能从钥匙串读取它的密钥，所以在这种模式下 keyshroud 打开 vault 前不会询问。想被询问，请用口令创建 vault（`KEYSHROUD_VAULT_KEY=passphrase`）。详见[安全模型](../README.md#security-model)。

## 完整文档

CLI 参考、`keyshroud://` 和 `bw://` 引用语法、配置变量和详细的安全模型，请参阅[英文 README](../README.md)。

## 许可证

[MIT](../LICENSE) © 2026 dinhkarate

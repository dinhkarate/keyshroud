<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**Agent dùng được key. Nhưng không bao giờ nhìn thấy key.**

**Giữ API key ngoài tầm mắt của Claude Code, Codex, Cursor, Cline, OpenCode, Gemini CLI, pi và omp** —
secret nằm trong [Vaultwarden](https://github.com/dani-garcia/vaultwarden) tự host của bạn (hoặc Bitwarden),
và mọi giá trị đều bị che trước khi model đọc được.

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

[🚀 Bắt đầu nhanh](#bắt-đầu-nhanh) · [🔐 Cài vault](../examples/vaultwarden#readme) · [🔌 Agent được hỗ trợ](#agent-được-hỗ-trợ) · [❓ Hỏi đáp](#hỏi-đáp) · [🌐 Website](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="Demo: keyshroud masks a GitHub token in command output while the command still uses it, and scan finds a key leaked into a test file" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

Lệnh nhận token thật. Transcript — và model đọc transcript — chỉ thấy `<redacted:GH_TOKEN>`.

## Vì sao cần keyshroud?

Agent cần credential để làm việc thật: `gh`, `npm publish`, CLI của cloud, webhook, database. Các cách thường dùng đều dở:

- ❌ **Dán key vào chat** — key nằm luôn trong transcript, log của nhà cung cấp, và mọi context về sau
- ❌ **Để trong `.env`** — agent `cat` file khi debug, hoặc commit nhầm
- ❌ **Trả tiền cho secrets manager** — `op run` cần gói 1Password, còn phần lớn "agent vault" là SaaS
- ❌ **Dùng MCP server của vault** — đa số trả thẳng plaintext cho model

**keyshroud giải quyết:**

- ✅ **Tên, không phải giá trị** — agent chỉ thấy `GH_TOKEN` và `bw://GitHub CLI token`
- ✅ **Che output** — giá trị nào lọt ra stdout/stderr đều thành `<redacted:GH_TOKEN>`
- ✅ **Vault của bạn** — Vaultwarden trên VPS $5 hay Raspberry Pi, hoặc Bitwarden; không cần tài khoản với chúng tôi
- ✅ **Miễn phí** — MIT, không telemetry

## Agent được hỗ trợ

| Agent | Cài đặt | Có gì |
|---|---|---|
| **Claude Code** | plugin (xem bên dưới) | hook che output SessionStart + PostToolUse, MCP tools, skill |
| **pi / omp** | `pi install npm:keyshroud` | nạp env, che `tool_result` (cả lệnh lỗi), `/secret` |
| **Codex** | `codex mcp add keyshroud -- keyshroud mcp` | MCP tools, output đã che |
| **Cursor, Claude Desktop, Cline, Gemini CLI** | JSON `mcpServers` | MCP tools, output đã che |
| **OpenCode** | `opencode mcp add keyshroud -- keyshroud mcp` | MCP tools, output đã che |
| **Shell hoặc CI bất kỳ** | `keyshroud run -- <cmd>` | inject env + che output |

## Bắt đầu nhanh

**Cần:** Node.js ≥ 22.18, Bitwarden CLI, và một vault.

**0. Chuẩn bị vault** — chọn một:

- **Tự host Vaultwarden** (miễn phí, server của bạn): làm theo
  [examples/vaultwarden](../examples/vaultwarden#readme) — Docker Compose + Caddy có HTTPS tự động,
  từ VPS trống tới `keyshroud doctor`, kèm backup và hardening (hướng dẫn bằng tiếng Anh).
- **Bitwarden cloud** (tài khoản miễn phí, không cần server): đăng ký ở [bitwarden.com](https://bitwarden.com)
  và bỏ qua `bw config server` bên dưới (tài khoản EU: `bw config server https://vault.bitwarden.eu`).

```bash
npm install -g keyshroud @bitwarden/cli    # hoặc: brew install bitwarden-cli

# 1. Trỏ bw vào server và đăng nhập một lần
bw config server https://vault.example.com
bw login

# 2. Cho keyshroud tự unlock (lưu trong keychain của hệ điều hành)
security add-generic-password -a "$USER" -s vaultwarden-master-password -w      # macOS: sẽ hỏi giá trị
# Linux: secret-tool store --label=vaultwarden service vaultwarden-master-password account "$USER"

# 3. Kiểm tra
keyshroud doctor

# Đã có .env? `keyshroud import` (chạy thử, chỉ in tên) rồi `keyshroud import --yes` → .env.refs
# 4. Lưu secret — gõ vào prompt có che, không hiện ra màn hình
keyshroud add --env GH_TOKEN --item "GitHub CLI token" --notes "gh for agents"

# 5. Dùng
keyshroud run -- gh auth status
keyshroud run -- claude          # chạy agent với mọi secret đã nối
```

### Claude Code

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

Lưu ý: khi một lệnh **lỗi**, Claude Code gọi `PostToolUseFailure`, hook này không sửa được output.
Vì vậy mọi lệnh dùng secret nên chạy qua `keyshroud run` (hoặc `secrets_run`) — lệnh đó tự che bất kể exit code.

### MCP client bất kỳ

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

OpenCode: `opencode mcp add keyshroud -- keyshroud mcp`.

Codex: `codex mcp add keyshroud -- keyshroud mcp`. Chế độ `codex exec` (không tương tác) từ chối lệnh MCP cần duyệt; cho phép tool của keyshroud:

```toml
# ~/.codex/config.toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```

Các tool: `secrets_list`, `secrets_run`, `secrets_request`, `vault_status`. Không tool nào trả về giá trị.

## Hỏi đáp

**Có bắt buộc Vaultwarden không?** Không. Bitwarden cloud chính hãng cũng chạy; keyshroud dùng server nào mà `bw` đang trỏ tới.

**Secret có ra khỏi máy không?** Chỉ đi giữa `bw` và server vault của bạn. keyshroud không có backend, không telemetry.

**Agent vẫn dùng được key chứ?** Được. Lệnh nhận giá trị thật; chỉ phần chữ model đọc là bị che.

**Đây có phải sandbox không?** Không. Nó chặn rò rỉ *vô tình*. Agent độc hại hoặc bị prompt injection vẫn có thể gửi giá trị ra ngoài — xem [security model](../README.md#security-model).

**Chạy trên Windows được không?** Chưa test. Hỗ trợ macOS và Linux.

## Tài liệu đầy đủ

CLI reference, cú pháp `bw://`, biến cấu hình và security model chi tiết nằm ở [README tiếng Anh](../README.md).

## License

[MIT](../LICENSE) © 2026 dinhkarate

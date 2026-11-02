<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**エージェントはキーを使える。でも、キーを見ることはない。**

**Claude Code、Codex、Cursor、Cline、OpenCode、Gemini CLI、pi、omp から API キーを遠ざける** —
シークレットは自分のマシン上の暗号化された vault に保管され（複数のマシンで共有したいときはセルフホストした
[Vaultwarden](https://github.com/dani-garcia/vaultwarden) や Bitwarden にも置けます）、モデルが読む前にすべての値がマスクされます。

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)

[🚀 クイックスタート](#クイックスタート) · [🔐 ローカル vault](#ローカル-vault) · [🔄 複数マシンで同期](#複数マシンで同期) · [🔌 対応エージェント](#対応エージェント) · [❓ よくある質問](#よくある質問) · [🌐 Web サイト](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="デモ：新しいマシンで keyshroud add がマスクされたプロンプトから GitHub トークンをローカル vault に保存し、keyshroud run がコマンドの出力でそれをマスクし、scan がログファイルに漏れたコピーを見つける" width="860"></p>

```console
$ keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

コマンドには本物のトークンが渡ります。トランスクリプト（とそれを読むモデル）に届くのは `<redacted:GH_TOKEN>` だけです。
（エージェントがコマンドを実行する場合は自動でマスクされます。人が操作するターミナルでは `--mask` で強制できます。）

## なぜ keyshroud？

コーディングエージェントが実際の作業をするには認証情報が必要です。`gh`、`npm publish`、クラウドの CLI、Webhook、データベースなど。よくあるやり方はどれも問題があります。

- ❌ **キーをチャットに貼り付ける** — トランスクリプト、プロバイダーのログ、この先のすべてのコンテキストウィンドウに残ります
- ❌ **`.env` に置く** — エージェントがデバッグ中に `cat` したり、うっかりコミットしたりします
- ❌ **有料のシークレットマネージャーを使う** — `op run` には 1Password のサブスクリプションが必要で、「エージェント向け vault」の多くはホスト型の SaaS です
- ❌ **vault の MCP サーバーを使う** — ほとんどが平文の値をそのままモデルに返します

**keyshroud ならこう解決します：**

- ✅ **値ではなく名前** — エージェントに見えるのは `GH_TOKEN` と `local://GitHub token` だけで、トークンそのものは見えません
- ✅ **出力のマスク** — stdout/stderr に出た値はすべて `<redacted:GH_TOKEN>` に置き換わります
- ✅ **準備はいらない** — 暗号化された vault ファイルと、OS のキーチェーンに置かれたその鍵。アカウントもサーバーも不要です
- ✅ **必要なら同期** — $5 の VPS や Raspberry Pi 上の Vaultwarden、または Bitwarden で複数のマシンから使えます
- ✅ **無料** — MIT ライセンス、テレメトリなし

## 対応エージェント

| エージェント | インストール | 使える機能 |
|---|---|---|
| **Claude Code** | [プラグイン](#claude-code) | SessionStart + PostToolUse のマスク用フック、スキル |
| **pi / omp** | [`pi install npm:keyshroud`](../README.md#pi--omp) | 環境変数への注入、`tool_result` のマスク（失敗した呼び出しも含む）、`/secret` |
| **Codex, OpenCode, Gemini CLI, Cursor agent** | [`npx skills add dinhkarate/keyshroud`](../README.md#other-agents-with-a-shell) | スキル + 出力がマスクされる CLI |
| **Claude Desktop、チャットのみのクライアント** | [`mcpServers` JSON](#任意の-mcp-クライアント) | 出力がマスクされる MCP ツール |
| **任意のシェルや CI** | `keyshroud run -- <cmd>` | 環境変数の注入 + 出力のマスク |

## クイックスタート

**必要なもの：** Node.js ≥ 22.18。それ以外は何もいりません。アカウントもサーバーも不要です。

```bash
npm install -g keyshroud

# 1. シークレットを保存 — マスクされたプロンプトに入力し、画面には表示されない。
#    最初の 1 件でローカル vault が作られる。
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. 使う
keyshroud run -- gh auth status
keyshroud run -- claude          # 紐付けたシークレットをすべて使える状態でエージェントを起動

# 3. 全体をチェック
keyshroud doctor
```

ターミナルがない場合（エージェントのシェルなど）、`add` はデスクトップに非表示入力のダイアログを開くので、
エージェントがコマンドを始め、あなたは値を貼り付けるだけです。`.env` がある場合：`keyshroud import`（ドライラン、名前のみ表示）
→ `keyshroud import --yes` で `.env.refs` を作成します。

### ローカル vault

`~/.config/keyshroud/vault.json` にすべての項目が入り、ランダムな 256 ビットの鍵で AES-256-GCM 暗号化されます（項目名も暗号化されます）。
鍵の置き場所はマシンによって異なります。

| マシン | 鍵 | ロック解除 |
|---|---|---|
| macOS | ログインキーチェーン、項目 `keyshroud-vault-<id>` | 不要 |
| デスクトップのキーリングと systemd がある Linux | Secret Service（`secret-tool`。`busctl` で検出） | 不要 |
| Windows | DPAPI（自分の Windows アカウントに紐付く） | 不要 |
| Docker、サーバー、キーリングがロックされた SSH、systemd のない Linux | パスフレーズから導出（scrypt） | `keyshroud unlock`。セッションは 30 分で終わる |

どのマシンでもパスフレーズを聞かれるようにしたい場合は、ターミナルで `KEYSHROUD_VAULT_KEY=passphrase keyshroud unlock`
を実行して vault を作ります（2 回入力、12 文字以上）。鍵をなくしたりパスフレーズを忘れたりすると復元できず、vault は 1 台のマシンのものです。
バックアップや複数マシンには Vaultwarden か Bitwarden を使ってください。

### 複数マシンで同期

- **Vaultwarden をセルフホスト**（無料、自分のサーバー）：[examples/vaultwarden](../examples/vaultwarden#readme) の手順に従います。
  Docker Compose + Caddy で HTTPS は自動。空の VPS から `keyshroud doctor` まで、バックアップとハードニングも含みます（英語のガイド）。
- **Bitwarden クラウド**（無料アカウント、サーバー不要）：[bitwarden.com](https://bitwarden.com) で登録し、
  下の `bw config server` は飛ばします（EU アカウント：`bw config server https://vault.bitwarden.eu`）。

```bash
npm install -g @bitwarden/cli

# 1. bw を自分のサーバーに向けて、一度だけログインする
bw config server https://vault.example.com
bw login

# 2. 以後の新しい項目は Vaultwarden へ（local:// の項目はそのまま使える）
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend

# 3. 30 分間アンロック（マスターパスワードを尋ねる。keyshroud は何も保存しない）
keyshroud unlock
```

keyshroud 0.7 を使っていたマシン（`bw` がログイン済み、keyshroud のファイルがある、キーチェーンにマスターパスワードがある）は
引き続き Vaultwarden が既定になり、何もする必要はありません。`local://…` と `bw://…` の参照は並べて使えます。

任意：*Settings → Security → Keys → API key* で取得した `vaultwarden-api-client-id` /
`vaultwarden-api-client-secret` もキーチェーンに入れておくと、`bw` のログインが切れたとき（logged out）に
keyshroud が自動で再ログインします。セッションが終わったあとはマスターパスワードを聞かれます。

### Claude Code

CLI をインストールしてから、プラグイン（マスク用フック + スキル）を入れます。

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

**制限**：コマンドが**失敗**すると Claude Code は `PostToolUseFailure` を発火しますが、このフックでは出力を書き換えられません。
そのため、スキルとセッションのコンテキストで、シークレットを使うコマンドはすべて `keyshroud run`（または `secrets_run`）経由で実行するよう Claude に指示しています。こちらは終了コードに関係なくプロセス内でマスクします。

### 任意の MCP クライアント

Codex、Cursor、Claude Desktop、Cline、Gemini CLI など、stdio で MCP を話すクライアントならどれでも使えます。

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

Codex：`codex mcp add keyshroud -- keyshroud mcp`。非対話の `codex exec` は承認が必要な MCP 呼び出しを拒否するため、keyshroud のツールを明示的に許可します：

```toml
# ~/.codex/config.toml
[mcp_servers.keyshroud.tools.secrets_run]
approval_mode = "approve"
```
OpenCode：`opencode mcp add keyshroud -- keyshroud mcp`。

ツール：`secrets_list`、`secrets_run`、`secrets_request`、`vault_status`。値を返すツールは一つもありません。

## よくある質問

**Vaultwarden は必須？** いいえ。既定ではシークレットは自分のマシン上の暗号化ファイルに入ります。Vaultwarden（または公式の Bitwarden クラウド）は任意で、同じシークレットを複数のマシンで使いたいときや、サーバーにコピーを置きたいときに使います。

**シークレットはマシンの外に出る？** ローカル vault なら出ません。Vaultwarden や Bitwarden の場合は `bw` と自分のサーバーの間だけです。keyshroud 自体のバックエンドはなく、テレメトリも送りません。値は実行するコマンドの環境変数に渡されるだけです。

**keyshroud 0.7 を使っています。何が変わる？** 何も変わりません。`bw` のログイン、keyshroud のファイル、auth.json の `bw://` や `!bw` の項目、`BW_SESSION`、キーチェーンのマスターパスワードのどれかがあるマシンは Vaultwarden を使い続け、その選択を `~/.config/keyshroud/backend` に書き込みます。

**それでもエージェントはキーを使える？** はい。コマンドには本物の値が渡り、マスクされるのはモデルが読むテキストだけです。

**これはサンドボックス？** いいえ。防げるのは*うっかり*の漏洩です。悪意のある、あるいはプロンプトインジェクションを受けたエージェントは、自分が使える値を外部に持ち出せてしまいます — [セキュリティモデル](../README.md#security-model)を参照してください。

**`.env` を `.gitignore` に入れるだけではダメ？** それで防げるのはコミットであって、読み取りではありません。エージェントはデバッグのために `.env` を読み、読んだ内容はモデルのプロバイダーに送られます。

**Windows で動く？** はい。Windows 10 + Node 22 でテスト済みです。ローカル vault の鍵は DPAPI で保護され、自分の Windows アカウントに紐付きます。Vaultwarden の場合、ロック解除のダイアログは小さな PowerShell ウィンドウで、セッションは同じく 30 分で終わります。Windows にはマスターパスワード用のキーチェーンがないため、keyshroud は毎回それを聞きます。詳しくは[英語の FAQ](../README.md#faq)。

**ローカル vault は誰が開ける？** 自分のユーザーとして動くプログラムなら（エージェントも含めて）キーチェーンから鍵を読めるので、このモードでは keyshroud は vault を開く前に確認しません。確認してほしい場合はパスフレーズで vault を作ってください（`KEYSHROUD_VAULT_KEY=passphrase`）。詳しくは[セキュリティモデル](../README.md#security-model)。

## ドキュメント全文

CLI リファレンス、`local://` と `bw://` 参照の構文、設定用の環境変数、詳しいセキュリティモデルは[英語版 README](../README.md) を参照してください。

## ライセンス

[MIT](../LICENSE) © 2026 dinhkarate

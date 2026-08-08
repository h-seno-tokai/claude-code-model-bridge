# claude-code-model-bridge

Claude Code の**サブエージェントを DeepSeek や Kimi で動かす**ための前段プロキシ．
Claude Code 本体には手を入れない．

```
Agent(subagent_type="deepseek", prompt="...")   # DeepSeek V4 Flash が動く
Agent(subagent_type="kimi",     prompt="...")   # Kimi K3 が動く
```

サブエージェントとして動くので，バックグラウンド実行，完了通知，`SendMessage` による追指示，
agent view でのセッション切り替えといった Claude Code の標準機能がそのまま使える．

> **English**: A local proxy that lets Claude Code run OpenAI-compatible models
> (DeepSeek, Kimi) as **native subagents**. It translates the Anthropic Messages API
> to OpenAI `chat/completions` for those models, and passes everything else through to
> `api.anthropic.com` **unmodified** — your Anthropic traffic and credentials are untouched.

---

## 解決する問題

安価で高性能なモデルに実装作業を任せたい場合，別の CLI (opencode 等) を
Bash から呼ぶ方法がある．しかしこの方法には以下の問題がある．

- **完了が通知されない**．定期的に起こしてログを見に行く polling が必要になる．
- **走っているセッションに追指示を送れない**．間違った方向に進んでも止められない．
- **agent view に出ない**．どれが動いているか一覧できない．

原因は Claude Code の外側でプロセスを回していることにある．
Claude Code の**サブエージェントとして中に入れれば**，これらは全部標準機能で片付く．

## 仕組み

Claude Code は Anthropic Messages API しか話さないが，これを成立させる拡張点が 2 つある．

### 1. サブエージェント定義の `model` は任意の文字列を受ける

`~/.claude/agents/*.md` の frontmatter にある `model` は enum ではなく文字列として検証される．
つまり存在しないモデル名でも書ける．

```yaml
---
name: kimi
description: ...
model: kimi-k3[1m]
---
```

一方で `Agent` ツール呼び出し時の `model` 引数は `sonnet|opus|haiku|fable` の enum に固定されている．
**したがってモデルを指定する経路はエージェント定義側になる**（`model` 引数を渡すと定義側を上書きして壊れる）．

### 2. 任意の base URL を firstParty 扱いにできる

接続先は `ANTHROPIC_BASE_URL` で差し替えられるが，既定では host が `api.anthropic.com` 以外だと
firstParty と判定されず，サブスクリプションの OAuth ログインが使われない．
`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` を立てるとこの判定が上書きされ，
**OAuth のまま**前段にプロキシを挟める．

この 2 つを組み合わせると，Claude Code 本体を一切改変せずに，
「モデル名で行き先を変える」プロキシを差し込める．

### 経路

```
Claude Code (firstParty / OAuth ログインのまま)
   │  ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ▼
proxy.mjs   model 名でプロバイダを決める
   ├ /^deepseek/i        → Anthropic Messages ⇄ OpenAI chat/completions → api.deepseek.com
   ├ /^(kimi|moonshot)/i → 同上                                        → api.moonshot.ai
   └ 一致しない          → ヘッダごと無改変で中継                      → api.anthropic.com
```

**Anthropic 宛の通信は改変しない．** メソッド・パス・ヘッダ・ボディをそのまま転送するだけで，
認証情報にも触れないし，別の宛先に向けることもしない．
横取りするのは「Anthropic に存在しないモデル名」のリクエストだけである．

## 必要なもの

- Claude Code（native build．動作確認は 2.1.226）
- Node.js 18 以上（`fetch` を使う．外部パッケージは不要）
- Python 3（回帰テストのみ）
- DeepSeek または Kimi (Moonshot) の API キー

## インストール

```bash
git clone https://github.com/h-seno-tokai/claude-code-model-bridge.git
cd claude-code-model-bridge
./install.sh
```

配置先は次のとおり．

| 配置先 | 内容 |
|---|---|
| `~/.claude/model-bridge/` | プロキシ本体と検証スクリプト |
| `~/.local/bin/claude-ds` | 起動ラッパへの symlink |
| `~/.claude/agents/{deepseek,kimi}.md` | サブエージェント定義 |

API キーを設定する．

```bash
$EDITOR ~/.claude/model-bridge/.env
```

```sh
export DEEPSEEK_API_KEY=...
export KIMI_API_KEY=...
```

## 使い方

```bash
claude-ds                      # bridge を起動してから Claude Code を開く
claude-ds --model kimi-k3[1m]  # メインループごと Kimi で動かす
claude-ds --bridge-restart     # proxy.mjs を編集したあとに反映する
```

`claude-ds` は bridge の health を確認し，落ちていれば起動してから `claude` を exec する．
bridge が上がらない場合は Claude Code を起動しない（全通信が死ぬのを防ぐため）．

**`claude` で起動した場合は bridge を経由しない．** その場合 DeepSeek / Kimi のモデルは
「存在しないモデル」としてエラーになり，Claude のモデルへ暗黙にフォールバックすることはない．

## プロバイダの追加

OpenAI の `chat/completions` 互換であれば，`proxy.mjs` の `PROVIDERS` に 1 エントリ足すだけでよい．

```js
{
  name: "example",
  re: /^example/i,                                   // この正規表現に一致する model を振り分ける
  chatUrl: "https://api.example.com/v1/chat/completions",
  keyEnv: "EXAMPLE_API_KEY",
  images: "url",                                     // vision 非対応なら "drop"
},
```

エージェント定義を `~/.claude/agents/` に置けば，その名前で `subagent_type` に指定できる．

## 変換の対応関係

| Anthropic | OpenAI |
|---|---|
| `system`（文字列 / ブロック配列） | 先頭の `role:"system"` メッセージ |
| `tool_use` ブロック | `assistant.tool_calls[]` |
| `tool_result` ブロック | `role:"tool"` メッセージ（対応する assistant の直後に配置） |
| `tools[].input_schema` | `functions[].parameters`（`$schema` は除去） |
| `tool_choice` の `any` / `tool` / `none` | `required` / `{type:"function"}` / `none` |
| `thinking` ブロック（送信時） | 落とす |
| `reasoning_content`（受信時） | `thinking` ブロック |
| `finish_reason` の `stop`/`tool_calls`/`length` | `stop_reason` の `end_turn`/`tool_use`/`max_tokens` |

OpenAI の function name は `[A-Za-z0-9_-]{1,64}` に限られるため，逸脱するツール名は
リクエストごとに置換し，応答で元の名前へ戻す（MCP のツール名などが該当する）．

### ストリーミング変換の注意点

`tool_calls` はチャンク分割されて届き，**分割位置も順序も保証されない**．素朴に
「名前が来たらブロックを開き，引数が来たら流す」と実装すると次の 2 つで壊れる．

- ツール名が `get_` / `weather` と分割されると，部分名 `get_` のままブロックが確定する
- 引数が名前より先に届くと，そのチャンクの引数が捨てられ JSON が壊れる

そのため本実装は**ストリームを受け切ってから tool_use ブロックをまとめて出す**．
引数の逐次表示は犠牲になるが，名前の欠けと引数の取りこぼしを構造的に排除できる．
テキストと thinking は通常どおり逐次流れる．

また，SSE を開始した後に上流が切断した場合，生の JSON をレスポンスに書くと
クライアントは完了を検知できずハングする．本実装は `event: error` として通知し，
`message_stop` を出さない．`finish_reason` が来ないまま終了した場合も同様に扱う
（無言の切り詰めを正常完了と誤認させない）．

## モデルの実測値

公式ドキュメントは "1M" のような丸めた表記なので，API のエラーメッセージから厳密値を取っている．

| | DeepSeek V4 Flash | Kimi K3 |
|---|---|---|
| 文脈長 | **1,048,576** | 1M（公称） |
| `max_tokens` 上限 | **393,216** | 上限の検証なし |
| vision | 非対応 | 対応 |

いずれも 2 進の K (1024) 基準であり，10 進の 1,000,000 ではない．

Claude Code は知らないモデルの文脈長を 200k と仮定する．モデル名に `[1m]` を付けると 1M 扱いになる
（`kimi-k3[1m]`）．このサフィックスは Claude Code 側でも bridge 側でも API 送信前に除去される．

推論モデルなので `max_tokens` が小さいと思考だけで予算を使い切り，本文が空のまま
`stop_reason=max_tokens` で返ることがある．最低でも数百トークンは与える．

## 設定

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `BRIDGE_PORT` | `8787` | 待ち受けポート |
| `BRIDGE_MAX_TOKENS` | `65536` | `max_tokens` の上限クランプ |
| `BRIDGE_EMIT_THINKING` | `1` | `reasoning_content` を thinking ブロックとして返す．`0` で捨てる |
| `BRIDGE_STRICT_FINISH` | `1` | `finish_reason` 無しの終了をエラーにする |
| `BRIDGE_UPSTREAM` | `https://api.anthropic.com` | 中継先 |
| `BRIDGE_LOG` | `<install>/bridge.log` | ログの出力先 |
| `BRIDGE_DEBUG` | 未設定 | `1` でログを stderr にも出す |

## 検証

```bash
~/.claude/model-bridge/verify.sh    # 静的 + 回帰テスト + 実走（両プロバイダ）
python3 ~/.claude/model-bridge/regress.py   # 回帰テストのみ（API キー不要・課金なし）
```

`regress.py` はモック上流を chunked で応答させ，次を再現して変換結果を検証する．

- 引数がツール名より先のチャンクで届く
- ツール名が複数チャンクに分割される
- `finish_reason` が来ないまま終了する
- ヘッダ送出後に上流が切断する
- `tool_calls` の index が 0 始まりでない

どのモデルがどこへ流れたかは `bridge.log` で確認できる．中継側も記録される．

```
kimi stream ok model=kimi-k3 tools=11 7970ms
anthropic passthrough model=claude-opus-5 200 13545ms
```

## 制約

- `cache_control` は対応概念が無いため無視する（プロバイダ自身の prefix cache は効く）．
- vision 非対応のプロバイダへ送る画像は落とす．
- `count_tokens` は文字数からの概算を返す．
- ツール入力の逐次表示は行わない（前述のとおり確定後にまとめて出す）．
- `/model` のモデル一覧に追加できるのは 1 件だけ（Claude Code 側の制約）．
  一覧に出ないモデルも `--model` とエージェント定義からは使える．

## 注意

- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` は先頭アンダースコアが示すとおり内部フラグであり，
  Claude Code の更新で名前や挙動が変わりうる．更新後は `verify.sh` を実行して確認する．
- 壊れた場合は `claude` で起動すれば元の状態に戻る（ラッパを使わなければ何も起きない）．
- 本ソフトウェアは Anthropic とは無関係であり，Anthropic による承認も支援も受けていない．
- 各モデル API の利用料は利用者が負担する．

## ライセンス

MIT

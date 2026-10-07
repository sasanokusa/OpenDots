# セルフホスト版の設定手順

## このForkで変わること

このForkは、OpenDots本体の会話保存をCopilotKit IntelligenceからSQLite（`DATABASE_PATH`の1ファイル）に置き換え、モデル呼び出しをすべてCommandCodeのProvider APIに向けます。追加したコードは`src/selfhost/`にあり、本体のファイルには差し込み口だけを足しています。`MODEL_ROUTER=on`にすると、Jevが依頼ごとに回し先を決めます。会話はMiMo-V2.6-Flash、計画はMiMo-V2.6-Pro、作業はDeepSeek V4.1 Flash、行き詰まったときの相談はClaude Sonnet 5.5が受け持ちます。ほかに、使用量メーター、夜間のバックログ実行、Discord DMを追加し、画面を日本語にしています。設計の詳細は`OpenDots_Fork_設計書.md`にあります。計画書の`OpenDots_Fork_計画書.md`と同じ場所に置いてあり、リポジトリの外にあるため、ここにはリンクを張りません。

`CONVERSATION_BACKEND`で本家の動作にも戻せます。`selfhost`はSQLite、`intelligence`は本家どおりです。未設定なら、Intelligenceのキーがないときは`selfhost`、あるときは`intelligence`になります。

## 前提

- Node.js 24以上とnpm
- CommandCode GOATプランのAPIキー。キーの発行と`.env`への記入はご自身で行ってください。
- Provider APIがプランで使えること。使えない場合、APIは403 `upgrade_required`を返します。次章のスモークテストで確かめられます。
- 任意: Docker（Dot Computerを使う場合。手順は`docs/COMPUTERS.md`）、`sqlite3`コマンド（バックアップ用）、Tailscaleかcloudflared（スマホから使う場合）

## 初回起動

まず`.env`を作ります。

```sh
cp .env.example .env
```

フェーズ2（ルーターなしで1モデルだけ使う状態）の最小構成は次のとおりです。

```dotenv
CONVERSATION_BACKEND=selfhost
MODEL_ROUTER=off
COMMAND_CODE_API_KEY=ここにCommandCodeのキー
OPENAI_MODEL=xiaomi/mimo-v2.6-flash
WEB_SEARCH_PROVIDER=disabled
DO_NOT_TRACK=1
COPILOTKIT_TELEMETRY_DISABLED=true
```

`.env.example`には`WEB_SEARCH_PROVIDER=parallel`や`# DO_NOT_TRACK=1`などの行が元からあります。同じ名前の行を2つ書くと後ろの行が有効になるので、元の行を書き換えるのが分かりやすい方法です。`COMMAND_CODE_API_KEY`を入れると、`OPENAI_API_KEY`と`OPENAI_BASE_URL`は使われません。`MODEL_ROUTER=off`のときは、`OPENAI_MODEL`が全ターンで使う唯一のモデルになります。

続けて依存を入れ、CommandCodeへの接続を確かめます。

```sh
npm ci
npm run selfhost:smoke
```

スモークテストは、`/models`の一覧、Jevの判定、会話・計画・ワーカーの3モデルによる通常応答とツール呼び出し1往復、Sonnet 5.5の`/messages`を1回ずつ試し、結果を表で出します。1回の実行で数セント以下の見込みです。1件でも失敗すると終了コード1で終わります。403 `upgrade_required`が出た場合は、プランにProvider APIが含まれていません。表の「est. USD」は設定ファイルの単価による推計です。

```sh
npm run dev
```

http://localhost:5173（http://127.0.0.1:5173でも開けます）を開きます。APIは4310番ポートで動きます。会話は`data/opendots.sqlite`に保存されるので、Intelligenceのキーは要りません。会話を1つ送ってからサーバーを止めて起動し直し、履歴が残っていることを確かめてください。

課金せずに画面だけ確かめたいときは、偽のプロバイダを使えます。

```sh
npm run selfhost:fake
```

表示されたURL（既定は`http://127.0.0.1:4399/provider/v1`、ポートは`FAKE_PROVIDER_PORT`で変えられます）を`COMMAND_CODE_BASE_URL`に、`COMMAND_CODE_API_KEY`には任意の文字列を入れて起動します。

Dot Computerを使う場合は、`docs/COMPUTERS.md`に従ってsupervisorをDockerで起動し、アプリはホストで動かします。同梱の`compose.yml`の`environment`にはForkの変数が含まれません。アプリ自体をコンテナで動かすには、`CONVERSATION_BACKEND`や`COMMAND_CODE_API_KEY`などを追記する必要があります。

## モデルルーターを有効にする

`.env`で`MODEL_ROUTER=on`にして、サーバーを再起動します。`OPENAI_MODEL`は使われなくなり、モデルは`src/selfhost/config/models.ts`の役割ごとの設定で決まります。モデルIDとしきい値を変えるときも、このファイルだけを編集します。

| 役割       | モデル                       | 受け持ち                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| router     | typesafe/jev                 | `/systemone`で依頼を分類します。回し先（chat、planner、worker）と、外部送信・削除・課金・本番反映を含む度合い（high_impact）を1回で答えます。3秒で打ち切り、失敗したときは固定ルール（600文字超か手順3つ以上ならplanner、それ以外はchat）で決めます。                                 |
| chat       | xiaomi/mimo-v2.6-flash       | 会話の窓口です。作業は`delegate_tasks`で1回2件までワーカーに渡します。3件以上、見通しが立たない、同じ作業でワーカーが2回続けて失敗した、渡す作業がhigh_impactと判定された、のどれかなら`handover_to_planner`でplannerに引き継ぎます（1ターン1回）。Dot Computerのツールは持ちません。 |
| planner    | xiaomi/mimo-v2.6-pro         | 計画と最終チェックです。本体の全ツール、`delegate_tasks`（同時3件、1回6件まで）、`ask_advisor`を持ちます。                                                                                                                                                                            |
| worker     | deepseek/deepseek-v4.1-flash | 委任された作業を実行します（1件5分、ループ20回まで）。Jevが単純な作業と判定した依頼を直接受けることもあります。ブラウザ操作はDotごとに1件ずつです。                                                                                                                                   |
| escalation | claude-sonnet-5-5            | `ask_advisor`からだけ呼ばれます。ツールは持たず、診断、修正後の計画、パッチを返します。1日3回、1ターン2回までです。                                                                                                                                                                   |

回し先は次の順で決まります。依頼が`/plan`か`/escalate`で始まるときはplannerです。そうでなければJevに聞き、high_impactが0.7以上ならplannerで、計画と最終チェックを必須にします。選んだ回し先の確率が0.6未満のときもplannerです。どちらでもなければJevの選択に従い、最後に使用量のポリシーで補正します。判定はすべて`sh_route_decisions`テーブルに残ります。1ターンの制限時間は`TURN_TIME_LIMIT_MS`で、既定は10分です。

## スラッシュコマンド

どちらも`MODEL_ROUTER=on`のときに、メッセージの先頭に書いたときだけ効きます。

- `/plan 依頼`: Jevを呼ばずにplannerで受けます。
- `/escalate 依頼`: plannerで受け、最初に`ask_advisor`でSonnetに相談させます。この最初の相談は、5時間枠の一時停止、月$8到達による自動停止、1日3回の上限を無視します。1ターン2回までの制限と、Sonnetが429でクールダウン中の断りは有効です。

## sasacodeをハーネスにする

`.env`で`AGENT_HARNESS=sasacode`にすると、Dotの会話ループを[sasacode](https://github.com/sasanokusa/sasacode)が受け持ちます。既定の`builtin`に戻せば、これまでのTanStack AIの仕組みに戻ります。

- 1回の発言ごとに`sasacode -p … --output jsonl --control stdio`を起動し、その出力を画面に流します。Web、Discord、定期タスク、バックログのどれから来た発言も同じです。
- sasacodeのモデル呼び出しは、アプリが127.0.0.1だけで開く中継を通ってCommandCodeに届きます。使用量の記録と枠のポリシーはこれまでどおり効き、CommandCodeのキーはsasacodeに渡りません。
- ページ操作、承認カード、ワーカーへの委任、Sonnetへの相談は、同じ中継のMCPでsasacodeに渡します。Spaceの権限はアプリ側で確かめます。
- 会話1つにsasacodeのセッション1つが対応します（`sh_sasacode_sessions`テーブル）。作業ディレクトリはDotごとです。

| 変数                     | 既定                                  | 内容                                                                    |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------- |
| `AGENT_HARNESS`          | `builtin`                             | `sasacode`で切り替えます                                                |
| `SASACODE_BIN`           | `sasacode`                            | 実行ファイルのパス                                                      |
| `SASACODE_HOME`          | `DATABASE_PATH`と同じ場所の`sasacode` | 設定とセッションの置き場所です。`config.json`は起動のたびに書き直します |
| `SASACODE_WORKDIR`       | `DATABASE_PATH`と同じ場所の`dots`     | Dotごとの作業ディレクトリの親です                                       |
| `SASACODE_PERMISSION`    | `agent`                               | 確認のしかたです（下を参照）                                            |
| `SASACODE_SSH_HOSTS`     | なし                                  | Dotが`ssh`で入れるほかのサーバー（カンマ区切り）。下を参照              |
| `SASACODE_PRIVATE_PATHS` | なし                                  | Dotに読ませないディレクトリ（絶対パス、カンマ区切り）                   |

シェルとファイルの扱いは次のとおりです。

- bashはサーバーの上で直接、アプリと同じユーザーで動きます。sudoは使えません。
- 読むだけのコマンド（`uptime`、`df`、`free`、`systemctl status`、`journalctl -u`、`docker ps`など）は確認なしで動きます。一覧は`src/selfhost/sasacode/config.ts`の`READ_ONLY_COMMANDS`です。`;`や`|`でつないだコマンドは、全部が一覧に当てはまるときだけ通ります。
- それ以外は、既定ではsasacodeのagentモードでモデルが1件ずつ安全かを判定し、危ないと判断したものだけ承認を求めます。判定には速くて安いDeepSeek V4.1 Flash（ワーカー役のモデル）を使い、費用はワーカー役として記録されます。Webの会話画面に出るカードか、DiscordのDMに届くボタンで「許可」か「拒否」を選びます。先に答えたほうが有効で、5分答えがなければ拒否になります。
- 判定のしかたは`SASACODE_PERMISSION`で変えられます。`agent`（既定、モデルが判定）、`edits`（作業ディレクトリ内の読み書きだけ確認なし、ほかはすべて承認）、`ask`（すべて承認）、`auto`（禁止ルール以外はすべて実行）です。
- `.env`、`~/.ssh`、`~/.config`、トークンやAPIキーを含むコマンドは、読み書きとも禁止しています。
- `SASACODE_PRIVATE_PATHS`に並べたディレクトリは、ファイルの読み書きと、そのパスを含むコマンドを禁止します。Googleの許可情報の置き場所（下の「外部サービスをつなぐ」）を入れておきます。コマンドの文字列で見ているので、別の書き方で回り込まれる余地は残ります。最後の守りはagentモードの判定です。
- `SASACODE_SSH_HOSTS`にサーバー名を並べると、Dotへの説明にそのサーバー名が入り、`ssh <サーバー名> <コマンド>`で確認できることをDotが知ります。ログインの設定（鍵やTailscale SSHのポリシー、`~/.ssh/config`のユーザー名）は先に済ませておきます。sshのコマンドは読むだけのものも含めて判定を通り、`ssh … sudo …`は禁止です。

saserverでは、sasacodeをGitHubのmainからビルドして使います。Bunはsasacodeの`packageManager`と同じ1.4.2を、GitHubのリリースから`SHASUMS256.txt`で検証して`/mnt/ssd/opendots/bun`に置いています。

```sh
# sasacodeの更新（GitHubのmainを取ってビルドし直す）
ssh saserver 'cd /mnt/ssd/opendots/sasacode && export PATH=/mnt/ssd/opendots/bun:$PATH && git pull --ff-only && bun install --frozen-lockfile && bun run build'
```

`.env`に`AGENT_HARNESS=sasacode`と`SASACODE_BIN=/mnt/ssd/opendots/sasacode/dist/sasacode`を足して、サービスを再起動します。

## 外部サービス（Google・GitHub）をつなぐ

本家の「Connections」を使います。Dotの設定（専門Dotを編集）の「接続」に、MCPサーバーのURLと、必要ならトークンを入れて「接続」を押します。詳しくは`docs/CONNECTIONS.md`にあります。

`AGENT_HARNESS=sasacode`のときの動き方は次のとおりです。

- つないだサービスのツールは、`<接続名>__<ツール名>`という名前でsasacodeに渡ります。sasacodeの確認はかけず、OpenDots側で次のように扱います。
- 読むだけのツール（サーバーが`readOnlyHint`を付けたもの）は、そのまま動きます。
- 「先に確認」がオンのツールは、Webの承認カードとDiscordのボタンで許可してから動きます。本家のチャット内の承認カードは使いません。
- ツールごとのオン・オフと「先に確認」は、接続の設定画面で変えられます。

### Google（Gmail・カレンダー・ToDo・ドライブ）

saserverでは[google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)（`workspace-mcp` 2.0.1）を、systemdのユーザーサービス`opendots-google.service`として127.0.0.1:8817で動かしています。

- uvは、GitHubのリリースからチェックサムを確かめて`/mnt/ssd/opendots/uv`に置き、`uv tool install workspace-mcp==2.0.1`で`/mnt/ssd/opendots/uv-tools`に入れました。
- 権限は`--permissions gmail:drafts calendar:full tasks:full drive:readonly docs:readonly`です。Gmailは読み取り・ラベル・下書きまでで、送信のツールはありません。ツールの範囲は`--tool-tier extended`です。
- OAuthクライアント（種類はデスクトップアプリ）は`/mnt/ssd/opendots/google/client_secret.json`に、許可情報は`/mnt/ssd/opendots/google/credentials/`に置きます（どちらも本人だけ読める権限）。既定のアカウントは`/mnt/ssd/opendots/google/env`の`USER_GOOGLE_EMAIL`です。
- Google Cloudの同意画面は「本番環境」にしておきます。「テスト」のままだと、7日で許可が切れます。
- 初回の許可は、Macから`ssh -N -L 127.0.0.1:8817:127.0.0.1:8817 saserver`で中継してから、ツールを呼んで返ってくるURLをMacのブラウザで開きます。許可後のリダイレクト先`http://localhost:8817/oauth2callback`が、この中継でsaserverに届きます。
- Dotの接続には、URL`http://127.0.0.1:8817/mcp`をトークンなしで登録します。

### GitHub

GitHubの公式MCPサーバーを、読むだけで使います。

1. GitHubの「Settings」→「Developer settings」→「Fine-grained tokens」でトークンを作ります。リポジトリは「All repositories」、権限はContents・Issues・Pull requests・Metadataを「Read-only」にします。
2. Dotの接続に、URL`https://api.githubcopilot.com/mcp/readonly`とそのトークンを登録します。トークンはサーバーのデータベースに入り、ブラウザには返りません。

## 毎朝のまとめ

`MORNING_BRIEF_AT=07:30`のように時刻（サーバーのタイムゾーン）を書くと、毎日その時刻に、DiscordのDMの会話でDotが残タスクのまとめを送ります。Discordの設定が必要です。

- DotはGoogle（予定・返事が要りそうなメール・ToDo）、GitHub（自分に関係するissueとPR、最近の動き）、スペースのページから、つながっているものだけを集めます。集め方はsasacodeのDotへの説明（`TASK_SWEEP`）にあり、会話で「残タスク出して」と頼んだときも同じように集めます。
- DMの会話の中で動くので、届いたまとめにそのまま返信して続きを頼めます。Webの会話一覧では「Discord DM」の中に、定期実行の印付きで残ります。
- サーバーが止まっていて時刻を過ぎた日は、起動から3時間以内なら1回だけ送ります。一時停止中は送りません。

## 使用量パネルとポリシー

サイドバーのUsageパネルには、5時間・週・月の3本のバー（上限は$14、$35、$70）、役割別の消化額、月の理想ペース（1日あたり$70÷30）との差、働いているポリシーが出ます。同じ内容が`GET /api/selfhost/usage`で取れます。金額はトークン数に設定ファイルの単価を掛けた推計で、実請求とは少しずれます。補正の方法は「週次の見直し」にあります。

枠の数え方はCommandCodeに合わせています。5時間枠と週枠は、枠が空いている状態で最初にリクエストした時刻に始まり、ちょうど5時間後・7日後にリセットされます（決まった時刻や曜日はありません）。月の枠は課金日にリセットされるので、`USAGE_MONTH_START_DAY`に課金日（1から31、Asia/Tokyo）を入れます。CommandCodeの利用状況画面に「Resets on Oct 22」とあれば`22`です。

メーターが数えられるのはOpenDotsからの呼び出しだけです。CLIなど別の道具からもCommandCodeを使っている場合は、パネルの「CommandCodeの表示と合わせる」に利用状況画面の数字（各枠の%と「Resets in 1d 15h」の部分）を入れてください。その枠がリセットされるまで、OpenDots外の消化分として足し込まれ、ポリシーの判定にも使われます。APIでは次のように送れます。

```sh
curl -X PUT http://127.0.0.1:4310/api/selfhost/usage/observed \
  -H "Authorization: Bearer $OWNER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"fiveHour":{"percent":0},"week":{"percent":1,"resetsIn":"1d 15h"},"month":{"percent":13}}'
```

5時間枠が「No usage in this window yet」のときは、`resetsIn`を付けずに`percent: 0`を送ります。

ポリシーは、ルーターが毎ターン読むフラグです。

| フラグ            | 条件                                                  | 動作                                                                                                                                        |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| pauseEscalation   | 5時間枠が80%以上                                      | `ask_advisor`を断ります（`/escalate`は除く）。                                                                                              |
| plannerUrgentOnly | 5時間枠が80%以上                                      | high_impact以外はchatで受けます。                                                                                                           |
| stopBacklog       | 週枠が80%以上                                         | バックログを実行しません。手動の実行も断ります。                                                                                            |
| plannerOverWeekly | plannerの週の消化が$3.75を超えた                      | Jevがplannerを選んでも確率0.8未満ならchatにします。低確率でplannerに回す場合もchatにします。chatからの引き継ぎはhigh_impactのときだけです。 |
| plannerReserved   | plannerの月の消化が$18以上                            | high_impact以外はchatで受けます。                                                                                                           |
| advisorManualOnly | escalationの月の消化が$8以上                          | 自動の相談を止め、`/escalate`だけにします。                                                                                                 |
| chatExhausted     | chatの月の消化が$20以上                               | chatの代わりにworkerで受けます。                                                                                                            |
| coolingDown       | 同じ役割で10分以内に429が2回                          | その役割を10分避け、planner、chat、workerの順で代わりを使います。                                                                           |
| behindPace        | 毎月21日以降で、月の消化が$50未満                     | 夜間のバックログを許可します。                                                                                                              |
| backlogWindowOpen | behindPaceで、stopBacklogでなく、日本時間の1時から7時 | 夜間のバックログが動きます。                                                                                                                |

## バックログAPI

月末に枠が余りそうなときに、急がない重い作業をためておき、夜間にworkerで消化させる仕組みです。操作はAPIだけで、画面にはまだありません。`OWNER_TOKEN`を設定している場合は、すべてのリクエストに`Authorization: Bearer`を付けます。POSTとDELETEには`content-type: application/json`も要ります。

| エンドポイント                           | 内容                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/selfhost/backlog`              | 一覧を返します。待機中のものが先で、状態は`queued`、`running`、`done`、`failed`、`cancelled`のどれかです。                               |
| `POST /api/selfhost/backlog`             | `{ "threadId": "...", "prompt": "..." }`で追加します（promptは3から4000文字）。結果は`threadId`の会話に残ります。会話がなければ404です。 |
| `DELETE /api/selfhost/backlog/:id`       | 待機中の項目を取り消します。それ以外は409です。                                                                                          |
| `POST /api/selfhost/backlog/:id/requeue` | `failed`か`cancelled`の項目を待機中に戻します。                                                                                          |
| `POST /api/selfhost/backlog/:id/run`     | 待機中の項目をすぐ実行します。結果を待たずに202で返ります。一時停止中、週枠が80%以上、ほかの項目が実行中のときは409です。                |

```sh
curl -s -X POST http://127.0.0.1:4310/api/selfhost/backlog \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"threadId":"会話のID","prompt":"来週の調査メモを下書きして"}'
```

自動実行は、`backlogWindowOpen`が立っている間（21日以降で月の消化が$50未満、週枠に余裕があり、日本時間の1時から7時）に、1分ごとの確認で1件ずつ動きます。サーバーの一時停止中は動きません。会話のIDは、`GET /api/workspace`の`conversations`で確かめられます。

## Discord DM

DMを受けるのは、`DISCORD_OWNER_USER_ID`のユーザーからのメッセージだけです。ほかの人のメッセージとサーバーのチャンネルは無視します。

1. Discord Developer Portal（https://discord.com/developers/applications）で「New Application」からアプリを作ります。
2. 左の「Bot」タブで「Reset Token」を押し、表示されたトークンを`DISCORD_BOT_TOKEN`に書きます。トークンは一度しか表示されません。「Public Bot」はオフにすると、ほかの人がBotを招待できなくなります。
3. 「Privileged Gateway Intents」はすべてオフのままにします。DMの受信にMessage Contentなどの特権インテントは要りません。
4. 「OAuth2」の「URL Generator」でスコープに`bot`を選びます。Botの権限は何も選ばないか、選んでも最小限にします。DMのやり取りにサーバーの権限は要りません。生成されたURLを開き、自分で作った非公開サーバーにBotを入れます。DMを送るには、Botと同じサーバーにいる必要があります。
5. Discordのユーザー設定の「詳細設定」で「開発者モード」をオンにします。サーバーのメンバー一覧で自分を右クリックし、「ユーザーIDをコピー」で取ったIDを`DISCORD_OWNER_USER_ID`に書きます。IDは17から20桁の数字です。トークンを設定してIDが違うと、起動時にエラーになります。
6. `.env`の次の項目を設定して、サーバーを再起動します。

```dotenv
DISCORD_BOT_TOKEN=手順2のトークン
DISCORD_OWNER_USER_ID=手順5のID
# DISCORD_DOT_ID=      DMに答えるDot。省略すると最初のDot
# PUBLIC_APP_URL=      スマホからアプリを開くURL
```

Botのプロフィールを開いてメッセージを送ると、返信が届きます。コマンドは`/new`（新しい会話にする）、`/stop`（実行中の処理を止める）、`/web`（`PUBLIC_APP_URL`を返す）、`/help`です。起動のたびにスラッシュコマンドとしてDiscordに登録するので、DMで「/」を打つと候補が出ます。`MODEL_ROUTER=on`のときは`/plan`と`/escalate`も出ます。打ち込んだ文字の`/new`なども、これまでどおり使えます。DMのチャンネル1つにWebの会話1つが対応し、Webの一覧には「Discord DM」という名前で出るので、続きをWebでも読めます。テキストのメッセージだけ受け付けます。ページのレビューのように承認が要る操作はDiscordでは行えません。`PUBLIC_APP_URL`を設定していれば、Webで承認するよう、そのURLを添えて返します。起動に失敗すると、サーバーのログに`A self-host service failed to start`と出ます。トークンの貼り間違いを最初に疑ってください。

同じトークンでサーバーを2か所（たとえばsaserverと手元のMac）で動かすと、両方がDMに返信して返事が二重になります。手元の`.env`にトークンを書いたまま開発サーバーを動かすときは、`DISCORD_BOT_TOKEN= DISCORD_OWNER_USER_ID= npm run dev`のように空の値を前に付けて起動してください。コマンドの前に付けた値は、`.env`の値より優先されます。

## スマホから使う

`npm run dev`のUIはlocalhost専用です。スマホから使うときは、ビルドしたアプリを常時動かします。

```sh
npm run build
npm start
```

UIとAPIが同じ4310番ポートで配られます。`HOST`は`127.0.0.1`のままにし、外からの入口はTailscaleかCloudflare Tunnelに任せます。エージェントがシェルとブラウザを持つため、どちらの場合も次の2つを`.env`に必ず設定します。

- `OWNER_TOKEN`: 24文字以上のランダムな文字列。`/api`はこの値をBearerトークンとして確かめ、画面を開くとトークンの入力を求めます。`HOST`をlocalhost以外にすると、24文字以上の`OWNER_TOKEN`がないとサーバーが起動しません。
- `APP_ORIGIN`: ブラウザで開くURLのオリジン（例: `https://opendots.example.ts.net`）。スキームとホスト名、必要ならポートだけを書き、パスと末尾のスラッシュは付けません。TLSを終端するプロキシを通すと、サーバーから見たオリジンがブラウザのものと食い違い、`Cross-origin requests are not allowed.`の403になります。複数あるときはカンマで区切ります。

### Tailscale

tailnetの中だけにHTTPSで公開します。管理画面でMagicDNSとHTTPS証明書を有効にしてから、アプリを動かすマシンで実行します。

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve status
```

スマホにもTailscaleを入れ、`https://マシン名.tailnet名.ts.net`を開きます。このURLを`APP_ORIGIN`に設定します。書式はTailscaleのバージョンで変わるので、通らないときは`tailscale serve --help`を見てください。インターネットへ公開する`tailscale funnel`は使いません。公開をやめるときは`tailscale serve reset`です。

### Cloudflare TunnelとAccess

独自ドメインがCloudflareにある場合の手順です。

```sh
cloudflared tunnel login
cloudflared tunnel create opendots
cloudflared tunnel route dns opendots opendots.example.com
```

`~/.cloudflared/config.yml`に入口を書き、トンネルを動かします。

```yaml
tunnel: opendots
credentials-file: /home/ユーザー名/.cloudflared/トンネルのID.json
ingress:
  - hostname: opendots.example.com
    service: http://127.0.0.1:4310
  - service: http_status:404
```

```sh
cloudflared tunnel run opendots
```

Cloudflare Zero Trustの「Access」でこのホスト名のSelf-hostedアプリケーションを作り、自分のメールアドレスだけを許可するポリシーを付けます。これを付けないと、トンネルはインターネットに開いたままです。`APP_ORIGIN`は`https://opendots.example.com`にします。`OWNER_TOKEN`はAccessと併用します。

## saserverで常時動かす

本番はsaserver（Ubuntu 24.04）で動いています。2026-10-07に次の形で配置しました。

| 項目         | 内容                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL          | https://saserver.tailbf5177.ts.net:8443 （tailnetの中だけ。443番は別のサービスが使用中）                                                                     |
| 置き場所     | `/mnt/ssd/opendots/app`（`selfhost`ブランチ）。`~/services/opendots` はそこへのリンク                                                                        |
| Node.js      | `/mnt/ssd/opendots/node26`（v26。`~/.local/opt/node26` はそこへのリンク。システムのNode 20には触れていない）                                                 |
| 設定         | `/mnt/ssd/opendots/app/.env`（権限600。`OWNER_TOKEN`、`APP_ORIGIN`、`PUBLIC_APP_URL`を追記済み）                                                             |
| 常駐         | systemdのユーザーサービス `opendots.service`（`UMask=0077`。`/mnt/ssd`がマウントされるまで15秒ごとに起動をやり直す）                                         |
| 公開         | `tailscale serve --bg --https=8443 http://127.0.0.1:4310`                                                                                                    |
| データ       | `/mnt/ssd/opendots/app/data/opendots.sqlite`（権限600。SSD側のsdbとsdc）                                                                                     |
| バックアップ | `opendots-backup.timer` が毎日4:30にシステムディスク（sda）の `~/backups/opendots` へ保存し、14世代残す。データと別のディスクに置くため、SSDには移していない |

画面を開くと`OWNER_TOKEN`の入力を求められます。値はsaserverで確かめます。

```sh
ssh saserver "grep '^OWNER_TOKEN=' ~/services/opendots/.env"
```

よく使う操作です。

```sh
# 状態とログ
ssh saserver 'systemctl --user status opendots --no-pager; journalctl --user -u opendots -n 50 --no-pager'
# 更新（pullしてビルドし直し、再起動）
ssh saserver 'cd ~/services/opendots && export PATH=$HOME/.local/opt/node26/bin:$PATH && git pull --ff-only && npm ci && npm run build && systemctl --user restart opendots'
# .envを変えたあと
ssh saserver 'systemctl --user restart opendots'
```

一から作り直すときの手順は次のとおりです。

1. `/mnt/ssd/opendots`を権限700で作り、Node.js 26をそこに展開して`node26`へリンクを張ります（`nodejs.org/dist`の`SHASUMS256.txt`で検証）。`~/.local/opt/node26`からもリンクを張ります。
2. `git clone -b selfhost https://github.com/sasanokusa/OpenDots.git /mnt/ssd/opendots/app`、続けて`npm ci`と`npm run build`を実行し、`~/services/opendots`からリンクを張ります。
3. 手元の`.env`を権限600で置き、`OWNER_TOKEN`（24文字以上のランダムな文字列）、`APP_ORIGIN`と`PUBLIC_APP_URL`（上のURL）を追記します。`HOST=127.0.0.1`は変えません。
4. `~/.config/systemd/user/opendots.service`を作り、`systemctl --user enable --now opendots`を実行します。saserverはlingerが有効なので、ログアウト後も動き続けます。

   ```ini
   [Unit]
   Description=OpenDots self-host fork (CommandCode, tailnet only)
   After=network-online.target
   StartLimitIntervalSec=0

   [Service]
   WorkingDirectory=/mnt/ssd/opendots/app
   ExecStartPre=/usr/bin/mountpoint -q /mnt/ssd
   ExecStart=/mnt/ssd/opendots/node26/bin/node --env-file=.env dist/server/server/index.js
   Restart=on-failure
   RestartSec=15
   UMask=0077

   [Install]
   WantedBy=default.target
   ```

5. `tailscale serve --bg --https=8443 http://127.0.0.1:4310`で公開します。saserverでは`sasa`がTailscaleのoperatorなので、sudoは要りません。

## バックアップ

SQLiteはWALモードで動いていて、書き込み途中の内容が`-wal`ファイルにあるため、`opendots.sqlite`を`cp`するだけでは一貫したコピーになりません。`npm run selfhost:backup`は`VACUUM INTO`で、アプリを止めずに一貫したコピーを`BACKUP_DIR`（既定は`data/backups`）に作ります。`sqlite3`コマンドは要りません。`BACKUP_KEEP`（既定14）より古いものは消します。saserverではタイマー（`opendots-backup.timer`）で毎日4:30に実行しています。

```sh
BACKUP_DIR=~/backups/opendots npm run selfhost:backup
```

バックアップはsaserverの同じディスクにあります。ディスクの故障に備えるなら、`~/backups/opendots`を別の機械にも定期的に写してください。`.env`にはキーとトークンが入っているので、データベースとは別の安全な場所に置きます。

戻すときは、サービスを止め（`systemctl --user stop opendots`）、バックアップを`DATABASE_PATH`の位置に置き、古い`-wal`と`-shm`ファイルを消してから起動します。

## 週次の見直し

週に1回、次を確かめます。

1. 引き継ぎの判定ミス候補。`handed_over=1`の行は、Jevがchatで足りると見たのに、途中でplannerに引き継がれた依頼です。質問文の言い回しやしきい値を直す材料になります。
2. `low_confidence`でplannerに回った依頼。多いときは、`routing.minConfidence`を下げるか質問文を直します。
3. Jevの失敗率と遅さ。`fallback_rule`の行と`jev_error`の件数を見ます。
4. 実請求との差。補正係数を更新します。
5. ポリシーの働きかた。週の途中で`plannerOverWeekly`が立ったか、`chatExhausted`が立ったかなどを、Usageパネルで見ます。立ちすぎるなら、役割ごとの配分を見直します。
6. バックアップが毎日できていること。

判定ログは`sqlite3 data/opendots.sqlite`で読めます。`GET /api/selfhost/decisions?limit=200`でも直近の判定が取れます。時刻は日本時間に直しています。

```sql
-- 引き継ぎが起きた依頼（判定ミス候補）
SELECT datetime(created_at/1000,'unixepoch','+9 hours') AS at_jst,
       final_role, reason, jev_choice, jev_probabilities, jev_high_impact,
       substr(input_excerpt,1,80) AS input
FROM sh_route_decisions
WHERE handed_over=1 AND created_at >= strftime('%s','now','-7 days')*1000
ORDER BY id DESC;

-- 低確率でplannerに回った依頼
SELECT datetime(created_at/1000,'unixepoch','+9 hours') AS at_jst,
       jev_choice, jev_probabilities, substr(input_excerpt,1,80) AS input
FROM sh_route_decisions
WHERE reason='low_confidence' AND created_at >= strftime('%s','now','-7 days')*1000
ORDER BY id DESC;

-- 回し先の内訳とJevの失敗
SELECT reason, final_role, count(*) AS n
FROM sh_route_decisions
WHERE created_at >= strftime('%s','now','-7 days')*1000
GROUP BY reason, final_role ORDER BY n DESC;

SELECT count(*) AS total, sum(jev_error IS NOT NULL) AS jev_errors,
       round(avg(jev_latency_ms)) AS avg_latency_ms
FROM sh_route_decisions
WHERE created_at >= strftime('%s','now','-7 days')*1000;
```

`reason`には、`jev`、`low_confidence`、`high_impact`、`command`、`fallback_rule`、`forced`（バックログなどサーバーが役割を指定した実行）、`policy:`で始まるポリシー補正が入ります。質問文を変えたときは、`src/selfhost/router/jev.ts`の`ROUTE_QUESTIONS_VERSION`を上げます。`questions_version`列で、版ごとの判定を比べられます。

実請求との突き合わせは、CommandCodeの利用状況画面の今週のモデル別金額と、推計の金額を並べて行います。推計はモデル別に集計できます。

```sql
SELECT model, count(*) AS calls, sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens, round(sum(cost_usd),4) AS est_usd
FROM sh_usage
WHERE at >= strftime('%s','now','-7 days')*1000
GROUP BY model ORDER BY est_usd DESC;
```

ずれが大きいモデルは、補正係数を更新します。新しい係数は、いまの係数に実請求÷推計を掛けた値です。係数はこれから記録する呼び出しの金額にだけ掛かり、記録済みの行は変わりません。

```sh
curl -s -X PUT http://127.0.0.1:4310/api/selfhost/usage/calibration \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"xiaomi/mimo-v2.6-flash","factor":1.2}'
```

係数は0より大きく10以下で、`GET /api/selfhost/usage/calibration`で現在の値を読めます。`OWNER_TOKEN`を設定していないときは、`Authorization`の行は不要です。

## upstreamの取り込み

本家の更新は週に1回取り込みます。

```sh
git fetch upstream
git switch selfhost
git merge upstream/main
```

衝突しうるのは、本体に差し込み口を足した次のファイルです。

- `src/server/index.ts`、`platform.ts`、`platform-config.ts`、`dot-agent.ts`、`runner.ts`
- `src/shared/types.ts`
- クライアントの`src/client/App.tsx`、`Chat.tsx`、`ThreadList.tsx`、`WorkspaceDialog.tsx`、`style.css`
- `package.json`、`package-lock.json`、`tsconfig.server.json`

`src/selfhost/`、`src/client/selfhost/`、`tests/selfhost/`、`scripts/`、`docs/selfhost/`は本家にないファイルなので、衝突しません。差し込み口の全体は、次のコマンドで一覧できます。

```sh
git diff --stat upstream/main...selfhost -- . ':!src/selfhost' ':!tests/selfhost' ':!scripts' ':!docs/selfhost'
```

衝突を解消したら、取り込みを終える前に次を実行します。`package-lock.json`が変わっていたら、先に`npm ci`を実行します。

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

本家のテストは、自前モードを使わない設定のままで通ることを条件にしています。落ちたテストが本家のものなら、差し込み口の変更が本家の動作を変えていないかを疑ってください。

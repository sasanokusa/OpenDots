import type { Pattern } from './index';

/**
 * Messages that arrive from the server, the browser or a library at runtime:
 * API `error` strings, thrown errors, and task progress lines. They are shown
 * through `tMessage`. Keys must match the server's English text exactly.
 */
export const entries: Record<string, string> = {
  // Browser network failures (the text differs by engine).
  'Failed to fetch': 'サーバーに接続できません。',
  'Load failed': 'サーバーに接続できません。',
  'NetworkError when attempting to fetch resource.':
    'サーバーに接続できません。',
  'Server returned an unreadable response.':
    'サーバーの応答を読み取れませんでした。',

  // Request guards and authentication (src/server/app.ts).
  'Request is too large.': 'リクエストが大きすぎます。',
  'Unrecognized host.': 'このホスト名は許可されていません。',
  'Cross-origin requests are not allowed.':
    'クロスオリジンのリクエストは許可されていません。',
  'Cross-site requests are not allowed.':
    'クロスサイトのリクエストは許可されていません。',
  'Enter your owner access token to unlock OpenDots.':
    'OpenDotsのロックを解除するには、オーナーのアクセストークンを入力します。',
  'Use application/json.': 'application/json を使用します。',
  'Not found.': '見つかりません。',
  'The server could not complete this request. Check server logs and database access.':
    'サーバーがリクエストを完了できませんでした。サーバーのログとデータベースへのアクセスを確認してください。',
  'The service request failed. Check the server configuration and try again.':
    'サービスへのリクエストが失敗しました。サーバーの設定を確認して、もう一度お試しください。',

  // Tasks.
  'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.':
    '依頼は3〜4,000文字で入力します。繰り返し間隔は60秒以上にします。',
  'Research is disabled in Settings.': '設定で調査が無効になっています。',
  'Select a conversation for this scheduled task.':
    'この定期タスクを実行する会話を選択します。',
  'Conversation is not owned by this workspace.':
    'この会話はこのワークスペースに属していません。',
  'Task not found.': 'タスクが見つかりません。',
  'Unknown task action.': '不明なタスク操作です。',
  'Repeat interval must be 60 seconds to one year, or null.':
    '繰り返し間隔は60秒から1年の範囲で指定するか、nullにします。',
  'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.':
    'この古いタスクにはIntelligenceの会話がありません。会話から新しい定期タスクを作成してください。',

  // Task history lines (src/server/store.ts, runner.ts, research.ts).
  'Task added to the research queue.': 'タスクを調査キューに追加しました。',
  'Repeat schedule removed.': '定期実行を解除しました。',
  'Research worker started.': '調査ワーカーを開始しました。',
  'Fictional sample brief ready.': '架空のサンプル要約ができました。',
  'Research brief ready.': '調査の要約ができました。',
  'Task queued for a new run.': '新しい実行のためにタスクを待機させました。',
  'Task paused.': 'タスクを一時停止しました。',
  'Task cancelled.': 'タスクをキャンセルしました。',
  'Running this task in its conversation.':
    'もとの会話でこのタスクを実行しています。',
  'Running this task in its Intelligence conversation.':
    'Intelligenceの会話でこのタスクを実行しています。',
  'Run interrupted because settings changed. Review completed effects before retrying.':
    '設定が変更されたため、実行を中断しました。再試行する前に、完了した処理の結果をレビューします。',
  'Worker lease expired. Review completed effects before retrying.':
    'ワーカーのリースが期限切れになりました。再試行する前に、完了した処理の結果をレビューします。',
  'Server stopped during this run. Review completed effects before retrying.':
    '実行中にサーバーが停止しました。再試行する前に、完了した処理の結果をレビューします。',
  'Run stopped.': '実行を停止しました。',
  'Run stopped because settings changed.':
    '設定が変更されたため、実行を停止しました。',
  'Run permission or lease was revoked.':
    '実行の権限またはリースが取り消されました。',
  'Run ownership check failed.': '実行の所有権を確認できませんでした。',
  'Unexpected research failure.': '調査中に予期しないエラーが発生しました。',
  'Preparing a fictional sample brief. No websites or model providers are contacted.':
    '架空のサンプル要約を準備しています。ウェブサイトやモデルプロバイダーには接続しません。',
  'Reading the requested sources with Parallel.':
    'Parallelで指定された出典を読み込んでいます。',
  'Searching and reading public sources with Parallel.':
    'Parallelで公開されている出典を検索し、読み込んでいます。',
  'Reading the requested public page in the isolated browser.':
    '隔離されたブラウザーで、指定された公開ページを読み込んでいます。',
  'Sources captured. Writing a brief grounded in the evidence.':
    '出典を取得しました。根拠に基づいて要約を書いています。',
  'Live mode is not configured. Set OPENAI_API_KEY and OPENAI_MODEL; browser research also needs BROWSER_URL and BROWSER_SECRET. Research must not be disabled.':
    'ライブモードが設定されていません。OPENAI_API_KEYとOPENAI_MODELを設定してください。ブラウザーでの調査にはBROWSER_URLとBROWSER_SECRETも必要です。調査を無効にしないでください。',
  'Please include a public https:// page URL. Open-ended web search is not configured; OpenDots will not invent sources.':
    '公開されているhttps://のページURLを含めてください。自由なウェブ検索は設定されていません。OpenDotsが出典を作り出すことはありません。',
  'Browser returned an invalid or empty source response.':
    'ブラウザーから、無効または空の出典の応答が返りました。',
  'Model provider returned an invalid or empty completion.':
    'モデルプロバイダーから、無効または空の応答が返りました。',
  'Parallel could not complete the web request. Retry later or check the provider quota.':
    'Parallelがウェブリクエストを完了できませんでした。しばらくしてから再試行するか、プロバイダーの利用枠を確認してください。',
  'Parallel returned an invalid response.':
    'Parallelから無効な応答が返りました。',
  'Parallel web research is disabled.': 'Parallelによるウェブ調査は無効です。',
  'Parallel found no usable sources. Try a more specific research request.':
    'Parallelで使える出典が見つかりませんでした。調査の依頼をもっと具体的にしてみてください。',
  'Parallel could not extract usable source evidence.':
    'Parallelが使える出典の根拠を取り出せませんでした。',
  'Only the first five URLs were read; coverage is limited.':
    '読み込んだのは先頭の5件のURLだけです。調査範囲は限られています。',
  'Some requested sources could not be read; coverage is incomplete.':
    '一部の出典を読み込めませんでした。調査範囲は不完全です。',
  'The provider returned warnings; some source evidence may be incomplete.':
    'プロバイダーから警告が返りました。出典の根拠が一部不完全な可能性があります。',

  // Memories and settings.
  'Memory must be between 1 and 2,000 characters.':
    '記憶は1〜2,000文字で入力します。',
  'Memory not found.': '記憶が見つかりません。',
  'Invalid settings.': '設定が正しくありません。',

  // Setup.
  'Invalid setup event.': 'セットアップのイベントが正しくありません。',
  'Setup step does not match server state.':
    'セットアップの手順がサーバーの状態と一致しません。',
  'Intelligence and model configuration are required.':
    'Intelligenceとモデルの設定が必要です。',
  'Browser is not configured: set BROWSER_URL and BROWSER_SECRET.':
    'ブラウザーが設定されていません。BROWSER_URLとBROWSER_SECRETを設定してください。',

  // Spaces, Dots and conversations.
  'Enter a Space name (up to 60 characters).':
    'スペース名を60文字以内で入力します。',
  'Provide a name, role instructions, and explicit tool permissions.':
    '名前、役割の指示、ツールの権限を指定します。',
  'Invalid specialist settings.': '専門Dotの設定が正しくありません。',
  'Invalid Learning settings.': 'Learningの設定が正しくありません。',
  'Use 1–64 lowercase letters, numbers, and single hyphens.':
    '1〜64文字の小文字、数字、単独のハイフンを使います。',
  'Dot Learning container ID must use 1–64 lowercase letters, numbers, and single hyphens.':
    'DotのLearningコンテナIDには、1〜64文字の小文字、数字、単独のハイフンを使います。',
  'Dot skill delivery requires a Learning container.':
    'Dotのスキル配信にはLearningコンテナが必要です。',
  'Dot not found.': 'Dotが見つかりません。',
  'Specialist Dot not found.': '専門Dotが見つかりません。',
  'Space access must include a valid default destination.':
    'スペースへのアクセスには、有効な既定の保存先を含める必要があります。',
  'Select a Dot and a conversation title.': 'Dotと会話のタイトルを指定します。',
  'Conversation does not belong to this Dot and owner.':
    'この会話は、このDotとオーナーのものではありません。',
  'Conversation not found.': '会話が見つかりません。',
  'Conversation scope denied.':
    'この会話の範囲へのアクセスは許可されていません。',
  'This runtime route is not enabled in OpenDots.':
    'このランタイムのルートは、OpenDotsでは有効になっていません。',
  'Intelligence could not create this conversation. Check the runtime key and connection.':
    'Intelligenceで会話を作成できませんでした。ランタイムのキーと接続を確認してください。',
  'The selected Dot is unavailable in the runtime.':
    '選択したDotは、ランタイムで利用できません。',
  'The current compute turn returned no assistant response.':
    '今回の処理から、アシスタントの応答が返りませんでした。',
  'Research permission is disabled.': '調査の権限が無効になっています。',
  'Dot could not start.': 'Dotを開始できませんでした。',
  'OpenDots could not complete this request. Please check the app and try again.':
    'OpenDotsがこのリクエストを完了できませんでした。アプリを確認して、もう一度お試しください。',
  'Thread already running': 'この会話はすでに実行中です。',
  'Stop the running turn before removing its history.':
    '履歴を削除する前に、実行中のターンを停止します。',
  'The worker returned no output.': 'ワーカーが出力を返しませんでした。',

  // Voice and Space requests handled by the workspace routes.
  'A conversation and audio SDP offer are required.':
    '会話と音声のSDPオファーが必要です。',
  'A bounded compute request and tool call ID are required.':
    '範囲を限定した処理の依頼と、ツール呼び出しIDが必要です。',
  'Transcript exceeds the 20,000 character limit.':
    '文字起こしが20,000文字の上限を超えています。',

  // Self-hosted routes: threads, usage and backlog.
  'Send a name (1–80 characters) or archived.':
    '名前（1〜80文字）かarchivedを指定します。',
  'Send a model and a factor between 0 and 10.':
    'モデルと、0〜10の係数を指定します。',
  'Send percent (0–100) per window, with resetsIn or resetsAt for open 5-hour and weekly windows.':
    '枠ごとの使用率（0〜100）を指定します。開いている5時間枠と週の枠には、resetsInかresetsAtも必要です。',
  'Backlog item not found.': 'バックログの項目が見つかりません。',
  'Send a threadId and a prompt of 3–4000 characters.':
    'threadIdと、3〜4000文字のプロンプトを指定します。',
  'Only queued items can be cancelled.': '待機中の項目だけキャンセルできます。',
  'Only failed or cancelled items can be queued again.':
    '失敗またはキャンセルした項目だけ、再度キューに入れられます。',
  'Background work is paused.': 'バックグラウンド作業は一時停止中です。',
  'Backlog is stopped because weekly usage is high.':
    '週の使用量が多いため、バックログは停止しています。',
  'Another backlog item is already running.':
    '別のバックログ項目がすでに実行中です。',
  'Only queued items can be run.': '待機中の項目だけ実行できます。',
  'Server stopped during this run.': '実行中にサーバーが停止しました。',
};

// Most specific first: the first matching pattern wins.
export const patterns: Pattern[] = [
  [/^Request failed \((\d+)\)\.$/, 'リクエストに失敗しました（$1）。'],
  [
    /^Setup required: (.+)\. Conversations require CopilotKit Intelligence\.$/,
    'セットアップが必要です: $1。会話にはCopilotKit Intelligenceが必要です。',
  ],
  [/^Voice setup required: (.+)\.$/, '音声通話のセットアップが必要です: $1。'],
  [/^Setup required: (.+)\.$/, 'セットアップが必要です: $1。'],
  [
    /^Repeats every (\d+(?:\.\d+)?) minutes after a successful run\.$/,
    '成功するたびに$1分ごとに繰り返します。',
  ],
  [/^Task queued\.$/, 'タスクを待機させました。'],
  [
    /^Research exceeded the (\d+(?:\.\d+)?) second time limit\.$/,
    '調査が制限時間（$1秒）を超えました。',
  ],
  [
    /^Sub-task exceeded its (\d+(?:\.\d+)?) second limit\.$/,
    'サブタスクが制限時間（$1秒）を超えました。',
  ],
  [
    /^This turn reached the (\d+(?:\.\d+)?) second time limit and was stopped\. Try a smaller request\.$/,
    'このターンは制限時間（$1秒）に達したため停止しました。依頼を小さくして試します。',
  ],
  [
    /^Browser failed \((\d+)\): Could not read the source\.$/,
    'ブラウザーでの読み込みに失敗しました（$1）: 出典を読み取れませんでした。',
  ],
  [
    /^Browser failed \((\d+)\): (.+)$/,
    'ブラウザーでの読み込みに失敗しました（$1）: $2',
  ],
  [
    /^Browser returned HTTP (\d+)\. Provide a public canonical page URL; redirects and private addresses are blocked\.$/,
    'ブラウザーからHTTP $1が返りました。公開されている正規のページURLを指定してください。リダイレクトとプライベートアドレスは許可されていません。',
  ],
  [
    /^Model provider returned HTTP (\d+)\. Check the server's model configuration and quota\.$/,
    'モデルプロバイダーからHTTP $1が返りました。サーバーのモデル設定と利用枠を確認してください。',
  ],
  [
    /^Intelligence runtime returned HTTP (\d+)\.$/,
    'IntelligenceランタイムからHTTP $1が返りました。',
  ],
  [
    /^The provider reported (\d+) source extraction error\(s\); coverage is incomplete\.$/,
    '出典の取り出しでプロバイダーから$1件のエラーが報告されました。調査範囲は不完全です。',
  ],
  [
    /^Skipped (\d+) malformed or empty source result\(s\); coverage is incomplete\.$/,
    '形式が正しくない、または空の出典の結果を$1件スキップしました。調査範囲は不完全です。',
  ],
  [
    /^fiveHour: an open window needs resetsIn or resetsAt\.$/,
    '5時間枠: 開いている枠にはresetsInかresetsAtが必要です。',
  ],
  [
    /^week: an open window needs resetsIn or resetsAt\.$/,
    '週の枠: 開いている枠にはresetsInかresetsAtが必要です。',
  ],
  [
    /^fiveHour: the reset time must fall within the window length from now\.$/,
    '5時間枠: リセット時刻は、今から枠の長さ以内にする必要があります。',
  ],
  [
    /^week: the reset time must fall within the window length from now\.$/,
    '週の枠: リセット時刻は、今から枠の長さ以内にする必要があります。',
  ],
  [
    /^CommandCode returned an unexpected (.+) response$/,
    'CommandCodeから予期しない形式の応答（$1）が返りました',
  ],
  [
    /^CommandCode (.+) failed with status (\d+)$/,
    'CommandCodeの$1がステータス$2で失敗しました',
  ],
  [
    /^(.+) does not support zero data retention$/,
    '$1はゼロデータ保持に対応していません',
  ],
];

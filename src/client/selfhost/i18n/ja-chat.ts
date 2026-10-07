import type { Pattern } from './index';

/** English UI text → Japanese. Keys must match the English source exactly. */
export const entries: Record<string, string> = {
  // Chat.tsx
  'Conversation context could not load. Retry before sending your message.':
    '会話の文脈を読み込めませんでした。メッセージを送る前に再試行してください。',
  'Conversation could not connect.': '会話に接続できませんでした。',
  'The current turn returned no response. Check the runtime connection and retry.':
    'このターンは応答がありませんでした。ランタイムの接続を確認して、もう一度お試しください。',
  'The turn failed. Your conversation remains saved.':
    'ターンに失敗しました。会話は保存されたままです。',
  Paused: '一時停止中',
  'Thinking…': '考え中…',
  'Here with you': 'そばにいます',
  'Connecting to your conversation…': '会話に接続しています…',
  'Save conversation as page': '会話をページとして保存',
  'Page title': 'ページのタイトル',
  'Could not save conversation.': '会話を保存できませんでした。',
  'Schedule a task in this conversation': 'この会話に定期タスクを設定',
  'Start voice call': '音声通話を開始',
  'End voice call': '音声通話を終了',
  'Talk with your Dot': 'Dotと話す',
  'Voice setup requires VOICE_API_KEY and VOICE_MODEL':
    '音声通話にはVOICE_API_KEYとVOICE_MODELの設定が必要です',
  'Working on': '作業中のページ:',
  'A LITTLE SPACE TO THINK': '考えるための小さなスペース',
  'What’s on your mind?': 'いま、何を考えていますか？',
  'Your conversation stays with this Dot, across text and calls.':
    '会話はこのDotに残り、テキストでも通話でも続けられます。',
  '{name} is thinking': '{name}が考えています',
  'Retry context': '文脈を再試行',
  Reconnect: '再接続',
  'Source page URL': 'ソースページのURL',
  'Remove source': 'ソースを削除',
  'Add source page link': 'ソースページのリンクを追加',
  'Message your Dot': 'Dotにメッセージ',
  'Message {name}…': '{name}にメッセージ…',
  'Stop response': '応答を停止',
  'Send message': 'メッセージを送信',
  'Text and voice, one conversation.': 'テキストも音声も、ひとつの会話です。',
  'Text is ready. Voice needs separate server configuration.':
    'テキストは利用できます。音声通話にはサーバーの別途設定が必要です。',

  // ChatTranscript.tsx
  Read: '既読',
  'Call failed': '通話に失敗しました',
  '{seconds}s · Call ended': '{seconds}秒 · 通話を終了しました',
  'Call in progress': '通話中',

  // CallView.tsx
  'Connecting…': '接続しています…',
  'Saving call…': '通話を保存しています…',
  'Microphone muted': 'マイクをミュート中',
  '{name} is speaking': '{name}が話しています',
  'Working on it…': '処理しています…',
  Listening: '聞いています',
  'Voice call with {name}': '{name}との音声通話',
  'Voice call': '音声通話',
  'Expand call view': '通話画面を広げる',
  'Minimize call view': '通話画面を小さくする',
  'Call duration': '通話時間',
  You: 'あなた',
  'Speak naturally. Your Dot is here with you.':
    '自然に話しかけてください。Dotがそばにいます。',
  'Enable call audio': '通話の音声をオンにする',
  'Mute call audio': '通話の音声をミュート',
  Speaker: 'スピーカー',
  End: '終了',
  'Unmute microphone': 'マイクのミュートを解除',
  'Mute microphone': 'マイクをミュート',
  Unmute: 'ミュート解除',
  Mute: 'ミュート',
  'Text and voice share this conversation':
    'テキストと音声は同じ会話を共有します',

  // useVoice.ts
  'Call ended, but its receipt could not be saved.':
    '通話は終了しましたが、記録を保存できませんでした。',
  'Call control connection was lost.': '通話の制御接続が切れました。',
  'Audio playback was blocked. Check your browser audio permissions.':
    '音声の再生がブロックされました。ブラウザーの音声の権限を確認してください。',
  'The voice connection dropped.': '音声接続が切れました。',
  'The voice provider reported a session error. End the call and retry.':
    '音声プロバイダーでセッションエラーが発生しました。通話を終了して再試行してください。',
  'Could not connect the call.': '通話に接続できませんでした。',

  // PageReviewCard.tsx, page-review-decision.ts
  'Could not restore this review.': 'このレビューを復元できませんでした。',
  'Could not save the approved draft.':
    '承認した下書きを保存できませんでした。',
  'Review page draft': 'ページ下書きのレビュー',
  'Review changed': 'レビューの内容が変更されました',
  'Saved to your Space': 'スペースに保存しました',
  'Saved, then deleted': '保存後に削除されました',
  'Checking saved review…': '保存済みのレビューを確認しています…',
  'Review ended': 'レビューを終了しました',
  'Ready for your review': 'レビューの準備ができました',
  'Needs new review': '新しいレビューが必要です',
  Approved: '承認済み',
  Checking: '確認中',
  'Not saved': '未保存',
  'You decide': 'あなたが決めます',
  'Preparing your draft…': '下書きを準備しています…',
  'This review was saved with a different draft. Start a new review for the changed draft.':
    'このレビューは別の下書きで保存されています。変更後の下書きは、新しいレビューを始めてください。',
  'Retry review': 'レビューを再試行',
  'Open saved page': '保存したページを開く',
  'Open page': 'ページを開く',
  'Saving…': '保存しています…',
  'Continue conversation': '会話を続ける',
  'Approve & save': '承認して保存',
  Decline: '却下',
  'Checking whether this draft was already saved.':
    'この下書きがすでに保存されているか確認しています。',
  'No page was saved.': 'ページは保存されませんでした。',
  'Nothing is saved until you approve.': '承認するまで何も保存されません。',

  // ConnectionActionCard.tsx
  'Could not load this request.': 'このリクエストを読み込めませんでした。',
  'Could not check this action.': 'この操作の状態を確認できませんでした。',
  'Could not run this action.': 'この操作を実行できませんでした。',
  'Approve connected-service action': '連携サービスの操作を承認',
  'Connected service': '連携サービス',
  Declined: '却下済み',
  Ended: '終了済み',
  'Preparing the action…': '操作を準備しています…',
  'Cannot run': '実行できません',
  'This card’s saved result belongs to a different approval request. Nothing was run for this one.':
    'このカードに保存された結果は、別の承認リクエストのものです。今回のリクエストでは、何も実行していません。',
  'Service error': 'サービスのエラー',
  'Service response': 'サービスの応答',
  'Running…': '実行しています…',
  'Approve & run': '承認して実行',
  'This action is still running on the server.':
    'この操作は、サーバー上でまだ実行中です。',
  'Nothing runs until you approve. These are the exact arguments.':
    '承認するまで何も実行されません。表示している引数が、そのまま渡されます。',

  // ComputerToolCard.tsx
  'Opening website': 'Webサイトを開く',
  'Inspecting browser': 'ブラウザーを確認',
  'Reading page': 'Webページを読む',
  'Viewing browser': 'ブラウザーを表示',
  'Clicking in browser': 'ブラウザーでクリック',
  'Typing in browser': 'ブラウザーで入力',
  'Using keyboard': 'キーボード操作',
  'Scrolling page': 'Webページをスクロール',
  'Saving file': 'ファイルを保存',
  'Reading file': 'ファイルを読む',
  'Listing files': 'ファイルを一覧表示',
  'Running terminal command': 'ターミナルコマンドを実行',
  'Using computer': 'コンピューターを使用',
  Interrupted: '中断',
  'Needs attention': '要確認',
  Finished: '完了',
  Working: '実行中',
  'Computer preview unavailable.':
    'コンピューターのプレビューを表示できません。',
  '{dotName} computer: {label}': '{dotName}のコンピューター: {label}',
  'Expand {dotName} computer': '{dotName}のコンピューターを拡大',
  'Computer terminal output': 'コンピューターのターミナル出力',
  '{dotName}’s computer · Current browser view':
    '{dotName}のコンピューター · 現在のブラウザー画面',
  "Current browser view from {dotName}'s computer":
    '{dotName}のコンピューターの現在のブラウザー画面',
  'Connecting to computer…': 'コンピューターに接続しています…',

  // ComputerPanel.tsx
  Browser: 'ブラウザー',
  Files: 'ファイル',
  Terminal: 'ターミナル',
  Activity: '履歴',
  'not configured': '未設定',
  stopped: '停止中',
  running: '実行中',
  unavailable: '利用不可',
  navigate: '移動',
  read: '読み取り',
  snapshot: 'スナップショット',
  screenshot: 'スクリーンショット',
  click: 'クリック',
  type: '入力',
  key: 'キー操作',
  scroll: 'スクロール',
  'files list': 'ファイル一覧',
  'files read': 'ファイル読み取り',
  'files write': 'ファイル書き込み',
  exec: 'コマンド実行',
  'human click': '手動クリック',
  'human type': '手動入力',
  'human key': '手動キー操作',
  'human scroll': '手動スクロール',
  permissions: '権限の変更',
  start: '起動',
  stop: '停止',
  take: '操作を引き継ぐ',
  release: '操作を戻す',
  owner: 'オーナー',
  agent: 'Dot',
  pending: '処理中',
  succeeded: '成功',
  failed: '失敗',
  'Could not refresh the screen.': '画面を更新できませんでした。',
  'Could not load the computer.': 'コンピューターを読み込めませんでした。',
  'Computer action failed.': 'コンピューターの操作に失敗しました。',
  "{name}'s computer": '{name}のコンピューター',
  'Computer status unavailable.': 'コンピューターの状態を取得できません。',
  'Loading computer…': 'コンピューターを読み込んでいます…',
  Refresh: '更新',
  'Working…': '処理しています…',
  'You have control': 'あなたが操作中',
  'Dot control': 'Dotが操作中',
  'Connect a computer service': 'コンピューターサービスに接続',
  'This Dot does not have a computer service configured. Configure the server’s computer service URL and token, then restart. Each Dot gets its own browser and workspace.':
    'このDotにはコンピューターサービスが設定されていません。サーバーのコンピューターサービスのURLとトークンを設定してから、再起動してください。Dotごとに専用のブラウザーとワークスペースが用意されます。',
  'Computer setup guide ↗': 'コンピューターのセットアップガイド ↗',
  'Computer tools': 'コンピューターのツール',
  'Enable Browser permission to use the screen.':
    '画面を使うには、ブラウザーの権限を有効にしてください。',
  'Browser URL': 'ブラウザーのURL',
  Go: '移動',
  'Browser screen': 'ブラウザー画面',
  'Click a point on the computer screen':
    'コンピューター画面上の位置をクリック',
  'Computer screen; take control to interact':
    'コンピューター画面。操作するには操作を引き継いでください',
  'Live browser screen for {name}': '{name}のブラウザー画面（ライブ）',
  'Refreshed {time}. Screen updates while this panel is open.':
    '{time}に更新しました。このパネルを開いている間、画面は自動で更新されます。',
  'Waiting for the browser screen…': 'ブラウザー画面を待っています…',
  'Start the computer with Browser permission to see its screen.':
    '画面を表示するには、ブラウザーの権限を付けてコンピューターを起動してください。',
  '{name} has control': '{name}が操作中',
  'Return control': '操作を戻す',
  'Take over': '操作を引き継ぐ',
  'Transferring control…': '操作を切り替えています…',
  'Keyboard & precise controls': 'キーボードと詳細操作',
  'Click the screen or enter coordinates below. Text goes directly to this browser, outside chat. Return control when finished.':
    '画面をクリックするか、下に座標を入力してください。テキストは会話を経由せず、このブラウザーに直接入力されます。終わったら操作を戻してください。',
  Click: 'クリック',
  'Text to type into computer': 'コンピューターに入力するテキスト',
  'Type into focused field': '選択中の入力欄に入力',
  Type: '入力',
  'Key to press': '押すキー',
  'Press key': 'キーを押す',
  'Scroll up': '上にスクロール',
  'Scroll down': '下にスクロール',
  'Workspace files': 'ワークスペースのファイル',
  'Paths are relative to this Dot’s persistent workspace.':
    'パスはこのDotの永続ワークスペースからの相対パスです。',
  Path: 'パス',
  'List files': 'ファイルを一覧表示',
  'Read file': 'ファイルを読む',
  'File contents': 'ファイルの内容',
  'File contents to save': '保存するファイルの内容',
  'Save file (replace contents)': 'ファイルを保存（内容を置き換え）',
  'Enable Workspace files permission to use these controls.':
    'これらの操作を使うには、ワークスペースのファイルの権限を有効にしてください。',
  'Runs inside this Dot’s computer. Commands stop after 30 seconds.':
    'このDotのコンピューター内で実行されます。コマンドは30秒で停止します。',
  'Terminal command': 'ターミナルコマンド',
  'Run command': 'コマンドを実行',
  'Enable Terminal commands permission to run commands.':
    'コマンドを実行するには、ターミナルコマンドの権限を有効にしてください。',
  Output: '出力',
  'Clear output': '出力をクリア',
  'Recent activity': '最近の履歴',
  'No computer actions yet.': 'コンピューターの操作はまだありません。',
  'Computer settings': 'コンピューターの設定',
  'Computer permissions': 'コンピューターの権限',
  'Choose what {name} and the computer controls can access.':
    '{name}やコンピューターの操作がアクセスできる範囲を選びます。',
  'Enable this computer': 'このコンピューターを有効にする',
  'Terminal commands': 'ターミナルコマンド',
  'Start computer': 'コンピューターを起動',
  'Stop computer': 'コンピューターを停止',
  'Stopping retains this Dot’s workspace files. Browser sessions may require signing in again.':
    '停止してもこのDotのワークスペースのファイルは残ります。ブラウザーのセッションは、再度ログインが必要になる場合があります。',

  // selfhost/ApprovalCard.tsx
  'Approval request': '承認リクエスト',
  'Needs your approval': '確認が必要です',
  'Expires in {time}': '残り{time}',
  Expired: '期限切れ',
  Reason: '理由',
  Allow: '許可',
  Deny: '拒否',
  'Sending…': '送信中…',
  'This request has already closed.': 'すでに締め切られました',
  'Could not send your answer.': '回答を送信できませんでした。',

  // Messages from the browser, CopilotKit and the API client.
  'Failed to fetch': 'サーバーに接続できませんでした。',
  'Load failed': 'サーバーに接続できませんでした。',
  'NetworkError when attempting to fetch resource.':
    'サーバーに接続できませんでした。',
  'Server returned an unreadable response.':
    'サーバーから読み取れない応答が返されました。',
  'Permission denied': 'マイクの使用が許可されていません。',
  'Permission denied by system': 'マイクの使用がシステムで許可されていません。',
  'Requested device not found': 'マイクが見つかりません。',
  'The request is not allowed by the user agent or the platform in the current context.':
    'マイクの使用が許可されていません。ブラウザーの設定を確認してください。',
  'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.':
    'マイクの使用が許可されていません。ブラウザーの設定を確認してください。',
  "Cannot read properties of undefined (reading 'getUserMedia')":
    'このブラウザーではマイクを使えません。HTTPSまたはlocalhostで開いてください。',
  'Run stopped by user': 'ユーザーが実行を停止しました。',
  'Run ended without emitting a terminal event':
    '実行が完了する前に終了しました。',

  // Server: turns and runs (dot-agent.ts, selfhost runner)
  'OpenDots could not complete this request. Please check the app and try again.':
    'OpenDotsはこのリクエストを完了できませんでした。アプリを確認して、もう一度お試しください。',
  'Specialist Dot not found.': '専門Dotが見つかりません。',
  'Intelligence and model configuration are required.':
    'Intelligenceとモデルの設定が必要です。',
  'Dot could not start.': 'Dotを起動できませんでした。',
  'Research permission is disabled.': '調査の権限が無効です。',
  'Browser is not configured: set BROWSER_URL and BROWSER_SECRET.':
    'ブラウザーが設定されていません。BROWSER_URLとBROWSER_SECRETを設定してください。',
  'Thread already running': 'この会話はすでに実行中です。',
  'Stop the running turn before removing its history.':
    '履歴を削除する前に、実行中のターンを停止してください。',
  'Conversation not found.': '会話が見つかりません。',
  'Conversation does not belong to this Dot and owner.':
    'この会話はこのDotとオーナーに属していません。',
  'Intelligence could not create this conversation. Check the runtime key and connection.':
    'Intelligenceで会話を作成できませんでした。ランタイムのキーと接続を確認してください。',
  'Intelligence request timed out. Retry to recover the same conversation.':
    'Intelligenceへのリクエストがタイムアウトしました。再試行すると同じ会話に戻れます。',
  'The server could not complete this request. Check server logs and database access.':
    'サーバーはこのリクエストを完了できませんでした。サーバーのログとデータベースへのアクセスを確認してください。',
  'The service request failed. Check the server configuration and try again.':
    'サービスへのリクエストに失敗しました。サーバーの設定を確認して、もう一度お試しください。',
  'Request is too large.': 'リクエストが大きすぎます。',

  // Server: voice calls (voice.ts, workspace-routes.ts)
  'This call has ended.': 'この通話は終了しています。',
  'Dot is paused.': 'Dotは一時停止中です。',
  'Voice setup required: VOICE_API_KEY and VOICE_MODEL.':
    '音声通話の設定が必要です: VOICE_API_KEYとVOICE_MODEL。',
  'An audio WebRTC SDP offer is required.':
    '音声のWebRTC SDPオファーが必要です。',
  'A conversation and audio SDP offer are required.':
    '会話と音声のSDPオファーが必要です。',
  'End the current call before starting another.':
    '別の通話を始める前に、現在の通話を終了してください。',
  'Call connection was cancelled or timed out.':
    '通話の接続がキャンセルされたか、タイムアウトしました。',
  'Call connection was cancelled.': '通話の接続がキャンセルされました。',
  'Voice provider did not return a controllable call identifier.':
    '音声プロバイダーが、操作できる通話IDを返しませんでした。',
  'Voice provider returned invalid SDP.':
    '音声プロバイダーが無効なSDPを返しました。',
  'Call session expired.': '通話セッションの有効期限が切れました。',
  'Call session expired after 15 minutes.':
    '通話セッションが15分で期限切れになりました。',
  'Call session expired; start a new call.':
    '通話セッションの有効期限が切れました。新しい通話を始めてください。',
  'Call stopped because the workspace was paused.':
    'ワークスペースが一時停止されたため、通話を停止しました。',
  'This call reached its six compute-turn limit. Start another call to continue.':
    'この通話は処理ターンの上限（6回）に達しました。続けるには新しい通話を始めてください。',
  'Transcript saved locally; pending Intelligence sync until workspace resumes.':
    '文字起こしはローカルに保存しました。ワークスペースが再開するまで、Intelligenceへの同期は保留中です。',
  'Call ended; its local receipt is saved, but Intelligence transcript sync failed.':
    '通話は終了し、記録はローカルに保存しましたが、Intelligenceへの文字起こしの同期に失敗しました。',
  'A bounded compute request and tool call ID are required.':
    '上限内の処理リクエストとツール呼び出しIDが必要です。',
  'Transcript exceeds the 20,000 character limit.':
    '文字起こしが20,000文字の上限を超えています。',
  'Call not found.': '通話が見つかりません。',

  // Server: computers (computer-service.ts, computer-routes.ts)
  'Dot not found.': 'Dotが見つかりません。',
  'Computer service is not configured.':
    'コンピューターサービスが設定されていません。',
  'Computer permission is disabled.': 'コンピューターの権限が無効です。',
  'Agents are paused.': 'Dotは一時停止中です。',
  'Computer service returned HTTP 409: refresh the browser with computer_snapshot before retrying. If the owner has control, wait for them to release it; do not bypass takeover.':
    'コンピューターサービスがHTTP 409を返しました。再試行する前にcomputer_snapshotでブラウザーを更新してください。オーナーが操作中の場合は、戻されるまで待ってください。引き継ぎを回避することはできません。',
  'Computer service returned an empty response.':
    'コンピューターサービスが空の応答を返しました。',
  'Computer response exceeded its size limit.':
    'コンピューターの応答がサイズの上限を超えました。',
  'Computer request was cancelled or timed out.':
    'コンピューターへのリクエストがキャンセルされたか、タイムアウトしました。',
  'Computer service is unavailable or returned an invalid response.':
    'コンピューターサービスが利用できないか、無効な応答を返しました。',
  'Computer service is unavailable. Check the supervisor configuration and connection.':
    'コンピューターサービスに接続できません。スーパーバイザーの設定と接続を確認してください。',
  'Invalid computer namespace.': 'コンピューターの名前空間が無効です。',
  'Computer identity mismatch.': 'コンピューターのIDが一致しません。',
  'Computer endpoint is not bound to this Dot.':
    'このコンピューターのエンドポイントは、このDotに紐づいていません。',
  'Start this Dot’s computer first.':
    '先にこのDotのコンピューターを起動してください。',
  'There is no active control request.': '有効な操作リクエストがありません。',
  'Unknown computer action.': '不明なコンピューター操作です。',
  'Human controls are owner-only.': '手動操作はオーナーのみ使えます。',
  'Invalid computer request.': 'コンピューターへのリクエストが無効です。',
  'Use a relative workspace path without traversal.':
    '上の階層をたどらない、ワークスペースからの相対パスを指定してください。',

  // Server: pages saved from a conversation or a review (pages.ts, page-*.ts)
  'Space not found.': 'スペースが見つかりません。',
  'Page not found in this Space.': 'このスペースにページが見つかりません。',
  'Space access has been revoked.': 'スペースへのアクセスが取り消されました。',
  'This Dot no longer has access to the selected Space.':
    'このDotは、選択したスペースにアクセスできなくなりました。',
  'Enter a valid page draft.': '有効なページの下書きを入力してください。',
  'Enter a valid page title and parent.':
    '有効なページのタイトルと親ページを入力してください。',
  'Enter a title (160 characters max) and Markdown content (100,000 max).':
    'タイトル（160文字まで）とMarkdownの内容（100,000文字まで）を入力してください。',
  'Pages require a title up to 160 characters and content up to 100,000 characters.':
    'ページには、160文字までのタイトルと100,000文字までの内容が必要です。',
  'Invalid JSON request.': 'リクエストのJSONが無効です。',
  'Page operation could not complete. Check Intelligence setup or retry; your draft has not been discarded.':
    'ページの操作を完了できませんでした。Intelligenceの設定を確認するか再試行してください。下書きは破棄されていません。',
  'This review was already saved to another Space.':
    'このレビューはすでに別のスペースに保存されています。',
  'This review was already saved with a different draft. Start a new review for the changed draft.':
    'このレビューはすでに別の下書きで保存されています。変更後の下書きは、新しいレビューを始めてください。',
  'This conversation has no persisted text to save.':
    'この会話には、保存できるテキストがありません。',
  'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.':
    'この会話はページの上限（100,000文字）を超えています。もっと短い会話を保存してください。',
};

export const patterns: Pattern[] = [
  [
    /^This turn reached the (\d+) second time limit and was stopped\. Try a smaller request\.$/,
    'このターンは$1秒の制限時間に達したため停止しました。依頼を小さくして、もう一度お試しください。',
  ],
  [
    /^Browser returned HTTP (\d+)\. Provide a public canonical page URL; redirects and private addresses are blocked\.$/,
    'ブラウザーがHTTP $1を返しました。公開されている正規のページURLを指定してください。リダイレクトとプライベートアドレスはブロックされます。',
  ],
  [
    /^Computer service returned HTTP (\d+)\.$/,
    'コンピューターサービスがHTTP $1を返しました。',
  ],
  [
    /^Voice provider returned HTTP (\d+)\. Check voice configuration and quota\.$/,
    '音声プロバイダーがHTTP $1を返しました。音声の設定と利用枠を確認してください。',
  ],
  [
    /^The local call stopped, but provider hangup returned HTTP (\d+)\.$/,
    '通話は停止しましたが、プロバイダー側の切断がHTTP $1を返しました。',
  ],
  [
    /^The local call stopped, but provider hangup timed out\.$/,
    '通話は停止しましたが、プロバイダー側の切断がタイムアウトしました。',
  ],
  [
    /^The local call stopped, but provider hangup failed \((.+)\)\.$/,
    '通話は停止しましたが、プロバイダー側の切断に失敗しました（$1）。',
  ],
  [
    /^Setup required: (.+)\. Conversations require CopilotKit Intelligence\.$/,
    'セットアップが必要です: $1。会話にはCopilotKit Intelligenceが必要です。',
  ],
  [/^Setup required: (.+)\.$/, 'セットアップが必要です: $1。'],
  [/^Request failed \((\d+)\)\.$/, 'リクエストに失敗しました（$1）。'],
  [
    /^CommandCode returned an unexpected (.+) response$/,
    'CommandCodeから想定外の$1応答が返されました。',
  ],
  [
    /^(.+) does not support zero data retention$/,
    '$1はゼロデータ保持に対応していません。',
  ],
  [
    /^CommandCode (.+) failed with status (\d+)$/,
    'CommandCodeの$1がステータス$2で失敗しました。',
  ],
];

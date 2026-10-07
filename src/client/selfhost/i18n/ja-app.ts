import type { Pattern } from './index';

/**
 * English UI text → Japanese for the app shell: sign-in, sidebar, activity and
 * memories, the workspace dialogs, the result pane and the usage panel. Keys
 * must match the English source exactly.
 */
export const entries: Record<string, string> = {
  // Sign-in and loading.
  'Your own little corner.': 'あなただけの小さな居場所。',
  'Enter the owner access token configured on this template’s server.':
    'サーバーに設定したオーナーのアクセストークンを入力します。',
  'Owner access token': 'オーナーのアクセストークン',
  'Unlock OpenDots': 'ロックを解除',
  'Access token was not accepted.':
    'アクセストークンが受け付けられませんでした。',
  'The token stays in this tab’s session storage.':
    'トークンは、このタブのセッションストレージにのみ保存されます。',
  'Finding your dots…': 'Dotを探しています…',
  Retry: '再試行',
  'Could not connect to the server.': 'サーバーに接続できません。',
  'Could not save.': '保存できませんでした。',
  'Could not create the conversation.': '会話を作成できませんでした。',
  'Leave your unsaved page draft?':
    '保存していないページの下書きを破棄して移動しますか？',
  'A new thought': '新しい会話',

  // Navigation.
  'Workspace navigation': 'ワークスペースのナビゲーション',
  'OpenDots home': 'OpenDotsのホーム',
  'Expand sidebar': 'サイドバーを開く',
  'Collapse sidebar': 'サイドバーを閉じる',
  'New chat': '新しい会話',
  'Open Spaces': 'スペースを開く',
  'Open activity': '履歴を開く',
  'Open settings': '設定を開く',
  'Open navigation': 'ナビゲーションを開く',
  'Close navigation': 'ナビゲーションを閉じる',
  'Show navigation': 'ナビゲーションを表示',
  'Hide navigation': 'ナビゲーションを隠す',
  DOTS: 'Dot',
  Dots: 'Dot',
  'Create Dot': 'Dotを作成',
  'Edit {name} settings': '{name}の設定を編集',
  SPACES: 'スペース',
  Spaces: 'スペース',
  'Create Space': 'スペースを作成',
  'RECENT CHATS': '最近の会話',
  'New conversation': '新しい会話',
  'Conversation sync unavailable. Check your runtime connection.':
    '会話を同期できません。ランタイムとの接続を確認してください。',
  'Your first conversation will live here.': '最初の会話がここに表示されます。',
  'Load more conversations': 'さらに読み込む',
  'Set up text chat to begin a persistent conversation.':
    '会話を始めるには、セットアップが必要です。',
  'Scheduled & activity': '定期タスクと履歴',
  Memories: '記憶',
  'Settings & setup': '設定とセットアップ',
  'Make it your own': 'カスタマイズ',
  'OPEN SOURCE TEMPLATE': 'オープンソーステンプレート',
  Activity: '履歴',
  Pages: 'ページ',
  'SELF-HOSTED': 'セルフホスト',
  'SETUP REQUIRED': 'セットアップが必要',
  'Resume all Dots': 'すべてのDotを再開',
  'Pause all Dots': 'すべてのDotを一時停止',
  Resume: '再開',
  Pause: '一時停止',
  'Hide computer': 'コンピューターを隠す',
  'Show computer': 'コンピューターを表示',
  'Dismiss error': 'エラーを閉じる',
  'All Dots are paused. Active compute stops and scheduled tasks wait.':
    'すべてのDotを一時停止しています。実行中の処理は止まり、定期タスクは待機します。',

  // New conversation screen.
  'Edit specialist': '専門Dotを編集',
  'Connect your Dot': 'Dotを接続',
  'Connect your model and conversation service in Settings to start chatting. Your Spaces and Dot preferences are ready to use.':
    '会話を始めるには、設定でモデルと会話サービスを接続します。スペースとDotの設定は、すぐに使えます。',
  'Setup and usage metadata is collected by default.':
    'セットアップと利用状況のメタデータは、既定で収集されます。',
  'Tracking and opt-out details': '収集内容とオプトアウトの方法',
  'Open the setup guide': 'セットアップガイドを開く',
  'Start a conversation': '会話を始める',
  'Message {name}…': '{name}にメッセージ…',
  'Your first conversation starts after setup.':
    'セットアップ後に、最初の会話を始められます。',
  'Text and calls, one continuing conversation':
    'テキストも音声通話も、ひとつの会話で続けられます',
  'Start conversation': '会話を始める',
  'Help me think this through': '考えを整理するのを手伝って',
  'Research a public page': '公開ページを調査して',
  'Make a plan I can follow': '実行しやすい計画を作って',
  'Setup details': 'セットアップの詳細',

  // Slack status values (setup.slack with underscores turned into spaces).
  online: 'オンライン',
  offline: 'オフライン',
  off: 'オフ',
  'not configured': '未設定',
  'setup required': 'セットアップが必要',
  'activation failed': '有効化に失敗',
  connecting: '接続中',
  starting: '起動中',
  degraded: '一部に問題あり',
  stopped: '停止中',

  // Activity and memories.
  'YOUR WORKSPACE': 'あなたのワークスペース',
  'A little follow-through.': 'ひとつずつ、最後まで。',
  'Preferences you choose to share with your Dots.':
    'Dotと共有する好みや前提を、自分で選べます。',
  'Scheduled turns run on the server in their original conversation.':
    '定期タスクは、もとの会話の中でサーバー上で実行されます。',
  'Add memory': '記憶を追加',
  'Available to permitted Dots': '許可したDotが利用できます',
  'Memory use disabled': '記憶の利用は無効です',
  'Edit memory': '記憶を編集',
  'Delete memory': '記憶を削除',
  'A little context goes a long way.':
    'ちょっとした前提が、大きな助けになります。',
  'Add a preference like “Keep my research briefs short.” You can change or remove it anytime.':
    '「調査の要約は短めに」のような好みを追加できます。あとから変更や削除もできます。',
  'Search tasks': 'タスクを検索',
  'Find a task…': 'タスクを探す…',
  'Let a thought come back around.': '思いついたことを、あとでもう一度。',
  'Open a conversation and use the clock button to schedule a server-side task.':
    '会話を開き、時計ボタンからサーバー側の定期タスクを設定します。',
  'Repeat interval in minutes (0 removes the schedule)':
    '繰り返す間隔（分）。0で定期実行を解除します。',
  'Enter a valid number of minutes.': '0以上の数値（分）を入力します。',
  '{count} saved runs': '保存された実行 {count}件',

  // Task rows and actions.
  'Pause task': 'タスクを一時停止',
  'Retry after review': 'レビュー後に再試行',
  'Retry task': 'タスクを再試行',
  'Resume task': 'タスクを再開',
  'Run again': 'もう一度実行',
  'Pause schedule': '定期実行を一時停止',
  'Edit schedule': '定期実行を編集',
  'Set a schedule': '定期実行を設定',
  Cancel: 'キャンセル',
  'Just now': 'たった今',
  '{minutes}m ago': '{minutes}分前',
  '{hours}h ago': '{hours}時間前',
  Scheduled: '定期実行',
  Queued: '実行待ち',
  Running: '実行中',
  Paused: '一時停止中',
  Completed: '完了',
  Failed: '失敗',
  Interrupted: '中断',
  Cancelled: 'キャンセル済み',
  'Repeats every {n} min': '{n}分ごとに繰り返し',
  'Repeats every {n} hr': '{n}時間ごとに繰り返し',

  // Dialogs.
  'A space for something.': 'スペースを作る',
  'Make this Dot yours.': 'このDotを調整する',
  'Meet your next specialist.': '新しい専門Dotを迎える',
  'Your workspace, your rules.': 'ワークスペースの設定',
  'Something to remember.': '記憶しておくこと',
  'Let your Dot keep time.': '定期タスクを設定',
  'Close dialog': 'ダイアログを閉じる',
  'OPENDOTS TEMPLATE': 'OPENDOTS テンプレート',
  'Could not save. Review the workspace error and retry.':
    '保存できませんでした。ワークスペースのエラーを確認して、もう一度お試しください。',
  Name: '名前',
  'Role instructions': '役割の指示',
  'What belongs here?': 'ここに置くもの',
  'Preference or context': '好みや前提',
  'Task to revisit': '繰り返すタスク',
  'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.':
    'あなたは思慮深い調査パートナーです。根拠を比べ、不確かな点ははっきり伝えます。',
  'Space access': 'スペースへのアクセス',
  'Choose where this Dot can read and edit pages.':
    'このDotがページを読んだり編集したりできるスペースを選びます。',
  'Default destination for saved pages': 'ページの既定の保存先',
  'Choose a Space': 'スペースを選択',
  'Public-page research': '公開ページの調査',
  'Allow the server-side read-only browser tool. Global settings always take precedence.':
    'サーバー側の読み取り専用ブラウザーツールを許可します。全体の設定が常に優先されます。',
  'Use saved memories': '保存した記憶を使う',
  'Include your preferences in new turns. Changing permission stops active work.':
    '新しいやり取りに、あなたの好みを含めます。権限を変更すると、実行中の作業は停止します。',
  'Automatic Learning': '自動Learning',
  'Learning container ID': 'LearningコンテナID',
  'Create this container in your Intelligence project first. New conversations will contribute evidence to it. Leave blank to keep new conversations out of Learning. Existing conversations retain their original assignment.':
    'Intelligenceプロジェクトで、先にこのコンテナを作成します。新しい会話は、ここに根拠を提供します。空欄にすると、新しい会話はLearningの対象外になります。既存の会話は、元の割り当てのままです。',
  'Use published skills': '公開済みスキルを使う',
  'Load reviewed skills from each conversation’s assigned container. Enable delivery in Intelligence too. Turning this off stops skill loading; it does not stop evidence collection.':
    '会話に割り当てたコンテナから、レビュー済みのスキルを読み込みます。Intelligence側でも配信を有効にします。オフにするとスキルの読み込みは止まりますが、根拠の収集は止まりません。',
  'Set up Learning and review skills ↗': 'Learningの設定とスキルのレビュー ↗',
  'Repeat after each successful run': '成功するたびに繰り返す間隔',
  'Every minute (testing)': '1分ごと（テスト用）',
  'Every hour': '1時間ごと',
  'Every day': '毎日',
  'Every week': '毎週',
  'Runs on the server in this same conversation, even with the tab closed. Failed or interrupted runs wait for manual retry. Review completed work before retrying an interrupted run.':
    'タブを閉じていても、サーバー上でこの会話の中で実行されます。失敗または中断した実行は、手動での再試行を待ちます。中断した実行を再試行する前に、完了した作業をレビューします。',
  'Service setup': 'サービスのセットアップ',
  'Add {items} to the server environment, then restart.':
    'サーバーの環境に{items}を追加して、再起動します。',
  'Text configuration is present. A successful conversation confirms connectivity.':
    'テキストの設定はそろっています。会話が成功すれば、接続を確認できます。',
  'Slack: {status}. Voice: {voice}.': 'Slack: {status}。音声通話: {voice}。',
  'configuration present': '設定済み',
  'needs VOICE_API_KEY and VOICE_MODEL': 'VOICE_API_KEYとVOICE_MODELが必要',
  'Template setup guide ↗': 'テンプレートのセットアップガイド ↗',
  'Memories are explicit preferences, not automatic learning. Avoid secrets; enabled memories go to your model provider.':
    '記憶は、自分で決めた好みであり、自動学習ではありません。秘密情報は入れないでください。有効な記憶は、モデルプロバイダーに送られます。',
  'Saving…': '保存中…',
  Save: '保存',

  // Dot settings: connected services (ConnectionsSection.tsx).
  Connections: 'サービス連携',
  'Give this Dot tools from MCP servers. Read-only tools run on their own; anything else asks you in chat before it runs. Tokens stay on the server.':
    'MCPサーバーのツールを、このDotに使わせることができます。読み取り専用のツールは、そのまま実行されます。それ以外は、実行する前にチャットで確認します。トークンはサーバーにだけ保存されます。',
  'Could not load connections.': 'サービス連携を読み込めませんでした。',
  'Request failed.': 'リクエストに失敗しました。',
  'token saved': 'トークン保存済み',
  'Refresh {name} tools': '{name}のツールを更新',
  'Remove {name}': '{name}を削除',
  'Remove {name} from this Dot?': 'このDotから{name}を削除しますか？',
  'This server offers no tools.': 'このサーバーが提供するツールはありません。',
  'read-only': '読み取り専用',
  'Ask first': '実行前に確認',
  'Add an MCP server': 'MCPサーバーを追加',
  'Name, e.g. GitHub': '名前（例: GitHub）',
  'MCP server URL': 'MCPサーバーのURL',
  'Bearer token (optional)': 'Bearerトークン（任意）',
  'Connecting…': '接続しています…',
  Connect: '接続',

  // Settings: appearance.
  Appearance: '外観',
  System: 'システム',
  Light: 'ライト',
  Dark: 'ダーク',
  'Saved in this browser. System follows your device.':
    'この設定は、このブラウザーに保存されます。「システム」を選ぶと、端末の設定に合わせます。',

  // Result pane and computer picker.
  Brief: '要約',
  '{name}’s computer': '{name}のコンピューター',
  'Close result panel': '結果パネルを閉じる',
  'Computer for': '対象のDot',
  'Select Dot computer': 'Dotのコンピューターを選択',
  'Create a Dot to give it a computer.':
    'Dotを作成すると、そのDot用のコンピューターを使えます。',
  'FICTIONAL SAMPLE BRIEF': '架空のサンプル要約',
  'RESEARCH BRIEF': '調査の要約',
  'Download brief': '要約をダウンロード',
  Sources: '出典',
  'An example of what Dot can do. The findings and sources below are invented.':
    'Dotができることの例です。以下の調査結果と出典は架空のものです。',
  '[Image: {alt}]': '[画像: {alt}]',
  '[Image omitted]': '[画像は省略されました]',
  'Source notes': '出典メモ',
  'Fictional source · not a live link': '架空の出典・実在しないリンク',
  'A little space for your findings.': '調査結果を置く、小さな場所。',
  'Resolve the error and retry to create a research brief.':
    'エラーを解消して再試行すると、調査の要約が作成されます。',
  'Your brief and sources will appear here after a successful run.':
    '実行に成功すると、要約と出典がここに表示されます。',

  // Mascot alt text and states.
  '{name} is {state}': '{name}は{state}です',
  idle: '待機中',
  working: '作業中',
  paused: '一時停止中',
  complete: '完了',
  'needs-input': '入力待ち',

  // Usage panel.
  'Escalation paused': 'エスカレーション停止',
  'The 5-hour window is nearly used up, so escalation waits.':
    '5時間枠をほぼ使い切ったため、エスカレーションは待機します。',
  'Planner: urgent only': 'プランナー: 緊急のみ',
  'The planner only takes urgent work until the 5-hour window recovers.':
    '5時間枠が回復するまで、プランナーは緊急の作業だけを受け付けます。',
  'Backlog stopped': 'バックログ停止',
  'The weekly limit is nearly used up, so background work is stopped.':
    '週の上限をほぼ使い切ったため、バックグラウンド作業は停止しています。',
  'Planner over weekly target': 'プランナー: 週の目標超過',
  'The planner has passed its weekly target and needs higher confidence.':
    'プランナーが週の目標を超えたため、より高い確信度が必要です。',
  'Planner reserved': 'プランナー: 予備枠に到達',
  'Planner spend has reached its monthly reserve.':
    'プランナーの支出が、月の予備枠に達しました。',
  'Advisor: manual only': 'アドバイザー: 手動のみ',
  'Escalation spend reached the automatic limit; only manual escalation runs.':
    'エスカレーションの支出が自動実行の上限に達したため、手動のエスカレーションのみ実行されます。',
  'Chat cap reached': '会話の上限に到達',
  'Chat has used its monthly cap.': '会話は、月の上限まで使われました。',
  '{role} cooling down': '{role}: クールダウン中',
  'Rate limited until {time}.': '{time}までレート制限中です。',
  'Behind pace': 'ペース遅れ',
  'Spend is below the ideal pace for this point in the month.':
    '今月のこの時点では、支出が理想のペースを下回っています。',
  'Backlog window open': 'バックログ実行可',
  'Background work may use the spare budget right now.':
    '今は、バックグラウンド作業が余った予算を使えます。',
  '5h': '5時間',
  '5-hour': '5時間枠',
  Week: '週',
  Weekly: '週間',
  Month: '月',
  Monthly: '月間',
  '{name} usage': '{name}の使用量',
  'On ideal pace': '理想のペースどおり',
  '{amount} ahead of ideal pace': '理想のペースより{amount}多い',
  '{amount} behind ideal pace': '理想のペースより{amount}少ない',
  'Day {day}: {spent} spent, {ideal} ideal':
    '{day}日目: {spent}使用、理想は{ideal}',
  unavailable: '取得できません',
  'loading…': '読み込み中…',
  'Model usage': 'モデルの使用量',
  Usage: '使用量',
  'Usage is unavailable right now.': '使用量を取得できません。',
  'Loading usage…': '使用量を読み込み中…',
  Role: '役割',
  'Active policies': '有効なポリシー',
  'Showing the last known numbers.': '最後に取得した数値を表示しています。',

  // Thread rename and archive.
  'Could not update the conversation.': '会話を更新できませんでした。',
  'Rename conversation': '会話の名前を変更',
  'Options for {label}': '{label}のオプション',
  Conversation: '会話',
  Rename: '名前を変更',
  Archive: 'アーカイブ',
};

export const patterns: Pattern[] = [];

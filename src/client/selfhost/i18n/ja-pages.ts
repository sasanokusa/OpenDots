import type { Pattern } from './index';

/**
 * English UI text → Japanese for Spaces, pages and the document editor.
 * Keys must match the English source exactly.
 */
export const entries: Record<string, string> = {
  // Page conversation
  'Save or resolve your document changes before starting page chat.':
    'ページの会話を始める前に、ドキュメントの変更を保存するか解決してください。',
  'Could not open page chat.': 'ページの会話を開けませんでした。',
  'Page conversation': 'ページの会話',
  'Close page chat': 'ページの会話を閉じる',
  'Add a specialist to work with this Space.':
    'このスペースで一緒に作業する専門Dotを追加してください。',
  'Create specialist': '専門Dotを作成',
  'Connect your assistant to chat about this page.':
    'このページについて会話するには、アシスタントを接続してください。',
  'Set up assistant': 'アシスタントを設定',
  'Ask about this page': 'このページについて質問',
  'Ask about this page…': 'このページについて質問…',
  'Page specialist': 'ページの専門Dot',
  'Assistant paused': 'アシスタントは一時停止中です',
  'Uses this saved page': '保存済みのページを使用します',
  'Send to page assistant': 'ページのアシスタントに送信',

  // Document screen
  'Load the latest saved page and replace this draft? Download your draft first if you want to keep it.':
    '最新の保存済みページを読み込み、この下書きを置き換えますか？残しておきたい場合は、先に下書きをダウンロードしてください。',
  'Could not load the latest page. Your draft is unchanged.':
    '最新のページを読み込めませんでした。下書きは変更されていません。',
  'Document workspace': 'ドキュメント編集',
  'All pages': 'すべてのページ',
  'Toggle page outline': 'ページの目次を切り替え',
  'Save now · ⌘/Ctrl S': '今すぐ保存 · ⌘/Ctrl S',
  'Visual editor': 'ビジュアルエディター',
  'Markdown source': 'Markdownソース',
  'This document needs source mode.':
    'このドキュメントにはソースモードが必要です。',
  'Move page': 'ページを移動',
  'New subpage': '新しい子ページ',
  'Download Markdown': 'Markdownをダウンロード',
  'Open source conversation': '元の会話を開く',
  'Delete page': 'ページを削除',
  'Delete "{title}"? This can\'t be undone. Any subpages will move to this page\'s parent.':
    '「{title}」を削除しますか？この操作は元に戻せません。サブページは、このページの親ページの下に移動します。',
  Untitled: '無題',
  'Could not delete page.': 'ページを削除できませんでした。',
  'Retry save': '保存を再試行',
  'Download draft': '下書きをダウンロード',
  'Load latest': '最新を読み込む',
  Dismiss: '閉じる',
  'Move under': '移動先',
  'Parent page': '親ページ',
  'Space root': 'スペースのルート',
  Done: '完了',
  'Page title': 'ページのタイトル',
  'Untitled page': '無題のページ',
  'Page Markdown': 'ページのMarkdown',
  'Loading editor…': 'エディターを読み込み中…',

  // Save status and autosave errors
  'Saving…': '保存中…',
  'All changes saved': 'すべての変更を保存済み',
  'Unsaved changes': '未保存の変更',
  'Changes need review': '変更のレビューが必要です',
  'Could not save': '保存できませんでした',
  'This page changed elsewhere. Your draft is safe. Copy it before loading the latest version.':
    'このページは別の場所で変更されました。下書きは保持されています。最新版を読み込む前に、下書きをコピーしてください。',
  'Use a title up to 160 characters and a document up to 100,000 characters. Your draft is still here.':
    'タイトルは160文字まで、ドキュメントは100,000文字までにしてください。下書きはそのまま残っています。',
  'Saving timed out. Your draft is safe; retry when connected.':
    '保存がタイムアウトしました。下書きは保持されています。接続を確認してから再試行してください。',
  'A newer revision exists. Your draft is preserved.':
    'より新しい版があります。下書きは保持されています。',
  'Could not save. Your draft is safe.':
    '保存できませんでした。下書きは保持されています。',

  // Markdown inspection reasons
  'This document contains extended Markdown. Source mode preserves it exactly.':
    'このドキュメントには拡張Markdownが含まれています。ソースモードなら、そのまま正確に保持されます。',
  'This document contains images, HTML, or formatting that needs Markdown source mode. Nothing has been changed.':
    'このドキュメントには、Markdownソースモードが必要な画像、HTML、または書式が含まれています。内容は何も変更されていません。',
  'Some formatting cannot be safely round-tripped. Source mode keeps the original document intact.':
    '一部の書式は、安全に変換し直すことができません。ソースモードなら、元のドキュメントがそのまま保たれます。',
  'This Markdown needs source mode to preserve its contents.':
    'このMarkdownの内容を保持するには、ソースモードが必要です。',

  // Outline
  'Pages in this Space': 'このスペースのページ',
  Pages: 'ページ',
  'New page in outline': '目次に新しいページを追加',
  'Close page outline': '目次を閉じる',

  // Library
  'Code block': 'コードブロック',
  '{name} page library': '{name}のページライブラリ',
  SPACE: 'スペース',
  'New page': '新しいページ',
  'Search pages': 'ページを検索',
  'Sort pages': 'ページを並べ替え',
  'Recently edited': '最近編集した順',
  'Name A–Z': '名前順',
  'Library view': 'ライブラリの表示',
  'Grid view': 'グリッド表示',
  'List view': 'リスト表示',
  'Search results': '検索結果',
  '{count} page': '{count}ページ',
  '{count} pages': '{count}ページ',
  'An empty page, ready to write.': '空のページです。書き始めましょう。',
  'Edited {date}': '{date}に編集',
  'No matching pages': '一致するページがありません',
  'No pages yet': 'まだページがありません',
  'Try a different title or phrase.':
    '別のタイトルやフレーズをお試しください。',
  'Create your first page to start organizing this Space.':
    '最初のページを作成して、このスペースの整理を始めましょう。',

  // Sidebar and workspace
  'Could not load pages.': 'ページを読み込めませんでした。',
  'Collapse {name}': '{name}を折りたたむ',
  'Expand {name}': '{name}を展開',
  'Could not create page.': 'ページを作成できませんでした。',
  'Space documents': 'スペースのドキュメント',
  'Page not found': 'ページが見つかりません',
  'Loading page…': 'ページを読み込み中…',
  'Back to all pages': 'すべてのページに戻る',

  // Editor
  'Page actions': 'ページの操作',
  'Start writing, or type / for blocks…':
    '書き始めるか、/ を入力してブロックを挿入…',
  'Page content': 'ページの内容',
  'Images and embedded content are not supported here. Use Markdown source to keep their original markup.':
    '画像や埋め込みコンテンツはここでは使用できません。元のマークアップを保持するには、Markdownソースを使用してください。',
  'Type {key} for blocks · ⌘/Ctrl + S to save':
    '{key} でブロックを挿入 · ⌘/Ctrl + S で保存',
  'Text formatting': 'テキストの書式',
  'Bold (⌘/Ctrl B)': '太字（⌘/Ctrl B）',
  Bold: '太字',
  'Italic (⌘/Ctrl I)': '斜体（⌘/Ctrl I）',
  Italic: '斜体',
  'Bullet list': '箇条書き',
  'Numbered list': '番号付きリスト',
  Quote: '引用',
  'Add link': 'リンクを追加',
  'Link URL (https:// or an internal page link)':
    'リンクのURL（https:// またはアプリ内のページリンク）',
  'Use a public http(s) URL or an internal page link.':
    '公開されているhttp(s)のURLか、アプリ内のページリンクを使用してください。',
  Undo: '元に戻す',
  Redo: 'やり直す',

  // Slash menu
  'INSERT BLOCK': 'ブロックを挿入',
  'No matching blocks': '一致するブロックがありません',
  'Insert block': 'ブロックを挿入',
  Text: 'テキスト',
  'Start with a plain paragraph': '通常の段落から書き始める',
  'Heading 1': '見出し1',
  'Heading 2': '見出し2',
  'Heading 3': '見出し3',
  'A large section heading': '大きなセクション見出し',
  'A medium section heading': '中くらいのセクション見出し',
  'A small section heading': '小さなセクション見出し',
  'A simple unordered list': '順序のないシンプルなリスト',
  'An ordered sequence': '順序のあるリスト',
  Checklist: 'チェックリスト',
  'Track things to do': 'やることを管理する',
  'Highlight a passage': '一節を強調する',
  Code: 'コード',
  'A code block': 'コードブロック',
  Divider: '区切り線',
  'Separate sections': 'セクションを区切る',
  Table: '表',
  'Three columns with a header': 'ヘッダー付きの3列',

  // Server messages shown on these screens (src/server/pages.ts,
  // page-routes.ts, page-service.ts, workspace-routes.ts, workspace.ts)
  'Space not found.': 'スペースが見つかりません。',
  'Page not found in this Space.': 'このスペースにページが見つかりません。',
  'A page cannot be moved into itself or a descendant.':
    'ページを自分自身や自分の子ページの下に移動することはできません。',
  'Pages require a title up to 160 characters and content up to 100,000 characters.':
    'ページには、160文字までのタイトルと100,000文字までの内容が必要です。',
  'This review was already saved to another Space.':
    'このレビューは別のスペースにすでに保存されています。',
  'This review was already saved with a different draft. Start a new review for the changed draft.':
    'このレビューは別の下書きですでに保存されています。変更後の下書きは、新しいレビューを開始してください。',
  'A valid page patch and expectedRevision are required.':
    'ページの更新内容と expectedRevision を正しく指定してください。',
  'This page changed. Reload the latest revision before saving your draft.':
    'このページは変更されました。下書きを保存する前に、最新の版を読み込んでください。',
  'This Dot no longer has access to the selected Space.':
    'このDotは、選択したスペースにアクセスできなくなりました。',
  'Enter a valid page draft.': '有効なページの下書きを入力してください。',
  'Enter a title (160 characters max) and Markdown content (100,000 max).':
    'タイトル（160文字まで）とMarkdownの内容（100,000文字まで）を入力してください。',
  'Choose a specialist.': '専門Dotを選択してください。',
  'Enter a valid page title and parent.':
    '有効なページのタイトルと親ページを入力してください。',
  'Invalid JSON request.': 'リクエストのJSONが無効です。',
  'Conversation does not belong to this Dot and owner.':
    'この会話は、このDotとオーナーのものではありません。',
  'Page operation could not complete. Check Intelligence setup or retry; your draft has not been discarded.':
    'ページの操作を完了できませんでした。Intelligenceの設定を確認するか、再試行してください。下書きは破棄されていません。',
  'Intelligence request timed out. Retry to recover the same conversation.':
    'Intelligenceへのリクエストがタイムアウトしました。再試行すると、同じ会話を復元できます。',
  'Choose a specialist in this Space with access enabled.':
    'このスペースへのアクセスが有効な専門Dotを選択してください。',
  'This page conversation is being created. Retry shortly.':
    'このページの会話を作成中です。しばらくしてから再試行してください。',
  'Space access has been revoked.': 'スペースへのアクセスが取り消されました。',
  'This conversation has no persisted text to save.':
    'この会話には、保存できるテキストがありません。',
  'This conversation exceeds the 100,000 character page limit. Save a shorter conversation.':
    'この会話はページの上限（100,000文字）を超えています。もっと短い会話を保存してください。',
  'Enter a Space name (up to 60 characters).':
    'スペース名を入力してください（60文字まで）。',
  'Space access must include a valid default destination.':
    'スペースへのアクセスには、有効な既定の保存先を含める必要があります。',
  'Dot not found.': 'Dotが見つかりません。',

  // Client and browser failures that surface through the page screens
  'Server returned an unreadable response.':
    'サーバーの応答を読み取れませんでした。',
  'Failed to fetch': 'サーバーに接続できませんでした。',
  'Load failed': 'サーバーに接続できませんでした。',
  'NetworkError when attempting to fetch resource.':
    'サーバーに接続できませんでした。',
};

export const patterns: Pattern[] = [
  [/^Request failed \((\d+)\)\.$/, 'リクエストに失敗しました（$1）。'],
];

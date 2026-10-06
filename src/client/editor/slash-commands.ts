import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion, {
  exitSuggestion,
  type SuggestionProps,
} from '@tiptap/suggestion';
import { t } from '../selfhost/i18n';
interface Block {
  /** English title; also the identifier. Translate it for display. */
  title: string;
  /** English description. Translate it for display. */
  description: string;
  /** Extra search terms (Japanese readings) so IME input finds the block. */
  keywords?: string;
  run: (editor: Editor, range: Range) => void;
}
const command =
  (action: (editor: Editor) => void) => (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).run();
    action(editor);
  };
export const blocks: Block[] = [
  {
    title: 'Text',
    description: 'Start with a plain paragraph',
    keywords: 'ほんぶん だんらく テキスト',
    run: command((e) => e.chain().setParagraph().run()),
  },
  ...([1, 2, 3] as const).map((level) => ({
    title: `Heading ${level}`,
    description:
      level === 1
        ? 'A large section heading'
        : level === 2
          ? 'A medium section heading'
          : 'A small section heading',
    keywords: '見出し みだし',
    run: command((e) => e.chain().setHeading({ level }).run()),
  })),
  {
    title: 'Bullet list',
    description: 'A simple unordered list',
    keywords: 'かじょうがき りすと リスト',
    run: command((e) => e.chain().toggleBulletList().run()),
  },
  {
    title: 'Numbered list',
    description: 'An ordered sequence',
    keywords: 'ばんごう りすと リスト',
    run: command((e) => e.chain().toggleOrderedList().run()),
  },
  {
    title: 'Checklist',
    description: 'Track things to do',
    keywords: 'ちぇっくりすと ちぇっく やること todo',
    run: command((e) => e.chain().toggleTaskList().run()),
  },
  {
    title: 'Quote',
    description: 'Highlight a passage',
    keywords: 'いんよう',
    run: command((e) => e.chain().toggleBlockquote().run()),
  },
  {
    title: 'Code',
    description: 'A code block',
    keywords: 'こーど こーどぶろっく ソースコード',
    run: command((e) => e.chain().toggleCodeBlock().run()),
  },
  {
    title: 'Divider',
    description: 'Separate sections',
    keywords: 'くぎりせん 罫線 くぎり',
    run: command((e) => e.chain().setHorizontalRule().run()),
  },
  {
    title: 'Table',
    description: 'Three columns with a header',
    keywords: 'ひょう てーぶる テーブル',
    run: command((e) =>
      e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    ),
  },
];
/** Matches English and Japanese titles, descriptions and keywords. */
export const searchBlocks = (query: string) => {
  const needle = query.toLowerCase();
  return blocks.filter((block) =>
    [
      block.title,
      block.description,
      t(block.title),
      t(block.description),
      block.keywords ?? '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  );
};
export const SlashCommands = Extension.create({
  name: 'slashCommands',
  addProseMirrorPlugins() {
    return [
      Suggestion<Block>({
        editor: this.editor,
        char: '/',
        startOfLine: true,
        allowedPrefixes: null,
        items: ({ query }) => searchBlocks(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let menu: HTMLDivElement | undefined;
          let current: SuggestionProps<Block> | undefined;
          let index = 0;
          const close = () => {
            menu?.remove();
            menu = undefined;
            const dom = current?.editor.view.dom;
            dom?.removeAttribute('aria-controls');
            dom?.removeAttribute('aria-activedescendant');
            dom?.removeAttribute('aria-autocomplete');
            document.removeEventListener('pointerdown', outside);
          };
          const outside = (event: PointerEvent) => {
            if (menu && !menu.contains(event.target as Node)) {
              if (current) exitSuggestion(current.editor.view);
              close();
            }
          };
          const paint = () => {
            if (!menu || !current) return;
            const props = current;
            menu.replaceChildren();
            const label = document.createElement('div');
            label.className = 'slash-menu-label';
            label.textContent = t('INSERT BLOCK');
            menu.append(label);
            if (!props.items.length) {
              const empty = document.createElement('p');
              empty.textContent = t('No matching blocks');
              menu.append(empty);
            }
            props.items.forEach((item, i) => {
              const button = document.createElement('button');
              button.type = 'button';
              button.id = `slash-block-${i}`;
              button.setAttribute('role', 'option');
              button.setAttribute('aria-selected', String(i === index));
              button.className = i === index ? 'selected' : '';
              const title = document.createElement('strong');
              title.textContent = t(item.title);
              const description = document.createElement('span');
              description.textContent = t(item.description);
              button.append(title, description);
              button.addEventListener('mousedown', (event) =>
                event.preventDefault(),
              );
              button.addEventListener('click', () => props.command(item));
              menu!.append(button);
            });
            const rect = props.clientRect?.();
            if (rect) {
              menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 332))}px`;
              menu.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 360))}px`;
            }
            props.editor.view.dom.setAttribute(
              'aria-activedescendant',
              `slash-block-${index}`,
            );
            menu
              .querySelector('.selected')
              ?.scrollIntoView({ block: 'nearest' });
          };
          return {
            onStart: (props) => {
              current = props;
              index = 0;
              menu = document.createElement('div');
              menu.id = 'document-block-menu';
              menu.className = 'slash-menu';
              menu.setAttribute('role', 'listbox');
              menu.setAttribute('aria-label', t('Insert block'));
              document.body.append(menu);
              props.editor.view.dom.setAttribute('aria-controls', menu.id);
              props.editor.view.dom.setAttribute('aria-autocomplete', 'list');
              document.addEventListener('pointerdown', outside);
              paint();
            },
            onUpdate: (props) => {
              current = props;
              index = 0;
              paint();
            },
            onExit: close,
            onKeyDown: ({ event, view }) => {
              if (event.isComposing || view.composing || event.keyCode === 229)
                return false;
              if (event.key === 'Escape') {
                exitSuggestion(view);
                close();
                return true;
              }
              if (!current?.items.length) return false;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                index =
                  (index +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    current.items.length) %
                  current.items.length;
                paint();
                return true;
              }
              if (event.key === 'Enter') {
                current.command(current.items[index]);
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});

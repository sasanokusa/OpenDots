/** Discord rejects messages over 2,000 characters; stay well under it. */
export const DISCORD_CHUNK_LIMIT = 1900;

const FENCE_CLOSE = '\n```';
const OPENS_FENCE = /^\s*```/;
const CLOSES_FENCE = /^\s*```\s*$/;
const BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

interface Cut {
  /** End of the chunk in the source text. */
  at: number;
  /** Fence line to reopen in the next chunk when the cut lands inside one. */
  reopen?: string;
}

function opensFence(line: string): boolean {
  // "```code```" on one line is inline code, not a fence.
  return OPENS_FENCE.test(line) && !line.trim().slice(3).includes('```');
}

function findCut(text: string, limit: number): Cut {
  let blankOut = 0;
  let lineOut = 0;
  let blankIn = 0;
  let lineIn = 0;
  let inFence = false;
  let fenceLine = '';
  let reopenBlank = '';
  let reopenLine = '';
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl < 0 ? text.length : nl + 1;
    if (next > limit) break;
    const line = text.slice(pos, nl < 0 ? text.length : nl);
    const blank = line.trim() === '';
    let openedHere = false;
    if (inFence) {
      if (CLOSES_FENCE.test(line)) inFence = false;
    } else if (opensFence(line)) {
      inFence = true;
      openedHere = true;
      fenceLine = line.trim();
    }
    if (!inFence) {
      lineOut = next;
      if (blank) blankOut = next;
    } else if (!openedHere && next + FENCE_CLOSE.length <= limit) {
      lineIn = next;
      reopenLine = fenceLine;
      if (blank) {
        blankIn = next;
        reopenBlank = fenceLine;
      }
    }
    pos = next;
  }
  if (blankOut) return { at: blankOut };
  if (lineOut) return { at: lineOut };
  if (blankIn) return { at: blankIn, reopen: reopenBlank };
  if (lineIn) return { at: lineIn, reopen: reopenLine };

  // No usable line break: hard cut. `inFence` still describes the state before
  // the line that straddles the limit, which is the state at the cut.
  if (inFence) {
    const at = limit - FENCE_CLOSE.length;
    return { at: lastSafeIndex(text, at), reopen: fenceLine };
  }
  return { at: lastSafeIndex(text, limit) };
}

function lastSafeIndex(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/**
 * Splits a reply into chunks of at most `limit` characters. Prefers blank
 * lines, then line breaks, then a hard cut; a fenced code block is kept whole
 * unless it alone exceeds the limit, in which case the fence is closed and
 * reopened across the chunks.
 */
export function splitMessage(
  text: string,
  limit: number = DISCORD_CHUNK_LIMIT,
): string[] {
  if (limit < 16) throw new RangeError('limit must be at least 16');
  const chunks: string[] = [];
  let rest = text.replace(BLANK_LINES, '');
  while (rest.trim() !== '') {
    if (rest.length <= limit) {
      chunks.push(rest.trimEnd());
      break;
    }
    const cut = findCut(rest, limit);
    const head = rest.slice(0, cut.at).trimEnd();
    let tail = rest.slice(cut.at);
    if (cut.reopen === undefined) {
      chunks.push(head);
      rest = tail.replace(BLANK_LINES, '');
      continue;
    }
    chunks.push(head + FENCE_CLOSE);
    // Skip the line break the cut left behind, but keep code indentation.
    tail = tail.replace(/^\r?\n/, '');
    // A reopened info string must not eat the room for content.
    const reopen = cut.reopen.length > limit / 4 ? '```' : cut.reopen;
    rest = CLOSES_FENCE.test(tail) ? '' : `${reopen}\n${tail}`;
  }
  return chunks;
}

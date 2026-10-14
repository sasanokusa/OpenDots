import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { describe, expect, it } from 'vitest';
import {
  MAX_MEMORIES,
  memoryTools,
  type MemoryStore,
} from '../../src/selfhost/agents/memory.js';
import type { Memory } from '../../src/shared/types.js';

function fakeStore(): MemoryStore & { list: Memory[]; allowed: boolean } {
  let next = 0;
  const store = {
    list: [] as Memory[],
    allowed: true,
    memories: () => [...store.list],
    saveMemory(text: string, id = `m${++next}`) {
      const memory = { id, text, createdAt: next };
      store.list = [memory, ...store.list.filter((item) => item.id !== id)];
      return memory;
    },
    deleteMemory(id: string) {
      const before = store.list.length;
      store.list = store.list.filter((item) => item.id !== id);
      return store.list.length < before;
    },
    settings: () => ({ memoryAllowed: store.allowed }),
  };
  return store;
}

function tool(tools: ToolDefinition[], name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found?.execute) throw new Error(`missing ${name}`);
  return (args: object) => found.execute!(args as never);
}

describe('memoryTools', () => {
  it('saves, rewrites, lists and deletes memories', async () => {
    const store = fakeStore();
    const tools = memoryTools(store, () => {});
    expect(tools.map((item) => item.name)).toEqual([
      'list_memories',
      'save_memory',
      'delete_memory',
    ]);
    const saved = (await tool(
      tools,
      'save_memory',
    )({
      text: 'Leave sabakan-agents out of the morning brief.',
    })) as Memory;
    await tool(
      tools,
      'save_memory',
    )({
      id: saved.id,
      text: 'Leave sabakan-agents out until the owner unfreezes it.',
    });
    expect(await tool(tools, 'list_memories')({})).toEqual([
      expect.objectContaining({
        id: saved.id,
        text: 'Leave sabakan-agents out until the owner unfreezes it.',
      }),
    ]);
    expect(await tool(tools, 'delete_memory')({ id: saved.id })).toEqual({
      deleted: saved.id,
    });
    expect(store.list).toEqual([]);
  });

  it('refuses unknown ids instead of creating a memory under them', async () => {
    const store = fakeStore();
    const tools = memoryTools(store, () => {});
    await expect(
      tool(tools, 'save_memory')({ id: 'nope', text: 'x' }),
    ).rejects.toThrow(/list_memories/);
    await expect(tool(tools, 'delete_memory')({ id: 'nope' })).rejects.toThrow(
      /not found/,
    );
    expect(store.list).toEqual([]);
  });

  it('stops adding at the cap but still allows rewrites', async () => {
    const store = fakeStore();
    const tools = memoryTools(store, () => {});
    for (let index = 0; index < MAX_MEMORIES; index++)
      store.saveMemory(`fact ${index}`);
    await expect(
      tool(tools, 'save_memory')({ text: 'one more' }),
    ).rejects.toThrow(/Merge or delete/);
    const [first] = store.list;
    await tool(tools, 'save_memory')({ id: first!.id, text: 'merged' });
    expect(store.list).toHaveLength(MAX_MEMORIES);
  });

  it('follows the Settings switch and the run check on every call', async () => {
    const store = fakeStore();
    let stopped = false;
    const tools = memoryTools(store, () => {
      if (stopped) throw new Error('aborted');
    });
    store.allowed = false;
    await expect(tool(tools, 'list_memories')({})).rejects.toThrow(
      /disabled in Settings/,
    );
    store.allowed = true;
    stopped = true;
    await expect(tool(tools, 'save_memory')({ text: 'x' })).rejects.toThrow(
      'aborted',
    );
    expect(store.list).toEqual([]);
  });
});

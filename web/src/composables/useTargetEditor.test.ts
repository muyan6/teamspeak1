import { expect, it, vi } from 'vitest';
import { useTargetEditor } from './useTargetEditor.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const form = () => ({ name: '', permissions: [] as string[] });

it('late A data never overwrites the successfully loaded B draft', async () => {
  const editor = useTargetEditor(form), a = deferred<ReturnType<typeof form>>();
  const old = editor.open('A', () => a.promise);
  await editor.open('B', async () => ({ name: 'B', permissions: ['own-bot'] }));
  a.resolve({ name: 'A', permissions: ['all'] }); await old;
  expect(editor.targetId.value).toBe('B'); expect(editor.draft.name).toBe('B');
  const persist = vi.fn(async () => {}); await editor.save('B', persist);
  expect(persist).toHaveBeenCalledWith('B', { name: 'B', permissions: ['own-bot'] });
});

it('late A error/finally cannot unset B loading or publish an old error', async () => {
  const editor = useTargetEditor(form), a = deferred<ReturnType<typeof form>>(), b = deferred<ReturnType<typeof form>>();
  let signal!: AbortSignal;
  const old = editor.open('A', (_id, s) => { signal = s; return a.promise; });
  const current = editor.open('B', () => b.promise);
  expect(signal.aborted).toBe(true);
  a.reject(new Error('A failed')); await old;
  expect(editor.loading.value).toBe(true); expect(editor.error.value).toBe('');
  expect(editor.canSave.value).toBe(false);
  b.resolve({ name: 'B', permissions: [] }); await current;
  expect(editor.canSave.value).toBe(true);
});

it('closing and reopening the same target still invalidates the old revision', async () => {
  const editor = useTargetEditor(form), oldRequest = deferred<ReturnType<typeof form>>();
  const old = editor.open('A', () => oldRequest.promise); editor.close();
  await editor.open('A', async () => ({ name: 'new A', permissions: [] }));
  oldRequest.resolve({ name: 'old A', permissions: [] }); await old;
  expect(editor.draft.name).toBe('new A');
});

it('saving while loading, after a failed load, or with a different target does nothing', async () => {
  const editor = useTargetEditor(form), request = deferred<ReturnType<typeof form>>();
  const persist = vi.fn(async () => {}), pending = editor.open('A', () => request.promise);
  expect(await editor.save('A', persist)).toBe(false);
  request.reject(new Error('offline')); await pending;
  expect(editor.error.value).toBe('offline'); expect(await editor.save('A', persist)).toBe(false);
  await editor.open('A', async () => ({ name: 'A', permissions: [] }));
  expect(await editor.save('B', persist)).toBe(false); expect(persist).not.toHaveBeenCalled();
});

it('save submits an immutable snapshot and rejects duplicate save clicks', async () => {
  const editor = useTargetEditor(form), saved = deferred<void>();
  await editor.open('A', async () => ({ name: 'A', permissions: ['one'] }));
  const persist = vi.fn((_id, _draft) => saved.promise), pending = editor.save('A', persist);
  editor.draft.permissions.push('two'); editor.draft.name = 'edited';
  expect(await editor.save('A', persist)).toBe(false);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(persist.mock.calls[0]).toEqual(['A', { name: 'A', permissions: ['one'] }]);
  saved.resolve(); expect(await pending).toBe(true); expect(editor.targetId.value).toBeNull();
});

it.each(['resolve', 'reject'] as const)('old save %s cannot close or change a newly saving editor', async (outcome) => {
  const editor = useTargetEditor(form), a = deferred<void>(), b = deferred<void>();
  await editor.open('A', async () => ({ name: 'A', permissions: [] }));
  const old = editor.save('A', () => a.promise);
  await editor.open('B', async () => ({ name: 'B', permissions: [] }));
  const current = editor.save('B', () => b.promise);
  if (outcome === 'resolve') a.resolve(); else a.reject(new Error('old failure'));
  expect(await old).toBe(false);
  expect(editor.targetId.value).toBe('B'); expect(editor.saving.value).toBe(true); expect(editor.error.value).toBe('');
  b.resolve(); expect(await current).toBe(true);
});

it('a current save failure retains the draft and allows retry', async () => {
  const editor = useTargetEditor(form);
  await editor.open('A', async () => ({ name: 'A', permissions: [] }));
  expect(await editor.save('A', async () => { throw new Error('save failed'); })).toBe(false);
  expect(editor.targetId.value).toBe('A'); expect(editor.error.value).toBe('save failed');
  expect(editor.canSave.value).toBe(true);
});

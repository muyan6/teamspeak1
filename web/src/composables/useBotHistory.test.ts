import { effectScope, ref, nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { useBotHistory } from './useBotHistory.js';
afterEach(() => vi.restoreAllMocks());

it('switching bot refetches history and discards the previous response', async () => {
  let release!: (v: any) => void;
  const get = vi.spyOn(axios, 'get').mockImplementationOnce(() => new Promise(r => { release = r; }))
    .mockResolvedValueOnce({ data: { history: [{ id: 'B-song' }] } });
  const scope = effectScope(), id = ref<string | null>('A');
  const data = scope.run(() => useBotHistory(() => id.value))!;
  id.value = 'B'; await nextTick(); await Promise.resolve();
  release({ data: { history: [{ id: 'A-song' }] } }); await Promise.resolve(); await nextTick();
  expect(get).toHaveBeenCalledTimes(2); expect(data.history.value[0].id).toBe('B-song');
  id.value = null; await nextTick(); expect(data.history.value).toEqual([]); scope.stop();
});

import { ref, watch, onScopeDispose } from 'vue';
import axios from 'axios';
import type { Song } from '../stores/player.js';
import { createLatestRequest } from './latestRequest.js';

export function useBotHistory(botId: () => string | null) {
  const history = ref<Song[]>([]), loading = ref(false);
  const requests = createLatestRequest();
  const stop = watch(botId, async id => {
    const ticket = requests.start();
    history.value = []; loading.value = !!id;
    if (!id) return;
    try {
      const res = await axios.get(`/api/player/${encodeURIComponent(id)}/history`, { signal: ticket.signal });
      if (ticket.isCurrent()) history.value = res.data.history ?? [];
    } catch { /* keep an empty list, never another bot's history */ }
    finally { if (ticket.isCurrent()) loading.value = false; }
  }, { immediate: true });
  onScopeDispose(() => { stop(); requests.cancel(); });
  return { history, loading };
}

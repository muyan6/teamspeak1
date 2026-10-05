import { computed, reactive, ref, toRaw } from 'vue';

/** A draft belongs to one successfully loaded target and one editor revision.
 * Closing/reopening invalidates every load/save callback from the old editor. */
export function useTargetEditor<T extends object>(emptyDraft: () => T) {
  const targetId = ref<string | null>(null);
  const loadedId = ref<string | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');
  const draft = reactive(emptyDraft()) as T;
  let revision = 0;
  let controller: AbortController | null = null;
  const canSave = computed(() => targetId.value !== null && loadedId.value === targetId.value && !loading.value && !saving.value);

  function close() {
    revision++;
    controller?.abort(); controller = null;
    targetId.value = loadedId.value = null;
    loading.value = saving.value = false;
    error.value = '';
    Object.assign(draft, emptyDraft());
  }

  async function open(id: string, load: (id: string, signal: AbortSignal) => Promise<T>) {
    close();
    const version = revision;
    const request = new AbortController(); controller = request;
    targetId.value = id; loading.value = true;
    const current = () => revision === version && targetId.value === id;
    try {
      const result = await load(id, request.signal);
      if (!current()) return;
      Object.assign(draft, result);
      loadedId.value = id;
    } catch (cause) {
      if (current()) error.value = cause instanceof Error ? cause.message : '加载失败，请重试';
    } finally {
      if (current()) { loading.value = false; controller = null; }
    }
  }

  async function save(id: string, persist: (id: string, draft: T) => Promise<void>): Promise<boolean> {
    if (id !== targetId.value || !canSave.value) return false;
    const version = revision;
    const current = () => revision === version && targetId.value === id;
    const submitted = structuredClone(toRaw(draft));
    saving.value = true; error.value = '';
    try {
      await persist(id, submitted);
      if (!current()) return false;
      close();
      return true;
    } catch (cause) {
      if (current()) error.value = cause instanceof Error ? cause.message : '保存失败，请重试';
      return false;
    } finally {
      if (current()) saving.value = false;
    }
  }

  return { targetId, draft, loading, saving, error, canSave, open, close, save };
}

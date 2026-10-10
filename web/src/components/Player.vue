<template>
  <div class="player-wrapper" v-if="currentSong">
    <Queue :open="showQueue" @close="showQueue = false" />

    <div class="player-bar frosted-glass">
      <!-- Progress bar (read-only display; seek interaction gated on transport / canTransport) -->
      <div
        class="progress-bar-container"
        :class="{ 'no-seek': !canTransport, 'is-dragging': isDraggingProgress }"
        ref="progressBarRef"
        @pointerdown="onProgressPointerDown"
        @pointermove="onProgressPointerMove"
        @pointerup="onProgressPointerUp"
        @pointercancel="onProgressPointerCancel"
        @mouseleave="onProgressMouseLeave"
      >
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }" />
          <div class="progress-bar-thumb" :style="{ left: progressPercent + '%' }" />
        </div>
        <div
          v-if="progressTooltipVisible"
          class="progress-tooltip"
          :style="{ left: progressTooltipX + 'px' }"
        >
          {{ progressTooltipTime }}
        </div>
      </div>

      <div class="player-left" @click="toggleLyrics">
        <CoverArt :url="currentSong.coverUrl" :size="40" />
        <div class="song-info">
          <div class="song-name" :title="currentSong.name">{{ currentSong.name }}</div>
          <div class="song-artist">
            <span v-if="showBotBadge" class="bot-badge">{{ activeBot?.name }}</span>
            <span class="artist-name" :title="currentSong.artist">{{ currentSong.artist }}</span>
          </div>
        </div>
      </div>

      <div class="player-center">
        <span class="time-display time-current">{{ formatTime(currentElapsed) }}</span>
        <!-- Transport controls: per-button gating honoring guest flags -->
        <template v-if="canControl || canTransport || canSkip || canModeCtl">
          <button v-if="canControl" class="control-btn" @click="store.prev()">
            <Icon icon="mdi:skip-previous" />
          </button>
          <button v-if="canTransport" class="play-btn" @click="togglePlay">
            <Icon :icon="store.isPlaying ? 'mdi:pause' : 'mdi:play'" />
          </button>
          <button v-if="canSkip" class="control-btn" @click="store.next()">
            <Icon icon="mdi:skip-next" />
          </button>
          <button v-if="canModeCtl" class="control-btn mode-btn" @click="cycleMode" :title="modeLabel">
            <Icon :icon="modeIcon" />
            <span class="mode-label">{{ modeLabel }}</span>
          </button>
        </template>
        <span class="time-display time-total">{{ formatTime(currentSong?.duration ?? 0) }}</span>
      </div>

      <div class="player-right">
        <!-- Volume gated on transport -->
        <template v-if="canTransport">
          <Icon icon="mdi:volume-high" class="volume-icon" />
          <input
            type="range"
            min="0"
            max="100"
            :value="volumeDisplay"
            @input="onVolumeInput"
            @change="onVolumeChange"
            @pointerup="onVolumeRelease"
            @pointercancel="onVolumeRelease"
            @blur="onVolumeRelease"
            class="volume-slider"
          />
        </template>
        <button class="control-btn" :class="{ active: showQueue }" @click="showQueue = !showQueue">
          <Icon icon="mdi:playlist-music" />
        </button>
        <button class="control-btn lyrics-btn" :class="{ active: route.path === '/lyrics' }" @click="toggleLyrics">
          <Icon icon="mdi:microphone" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';
import { useDecoupledSlider } from '../composables/useDecoupledSlider.js';
import CoverArt from './CoverArt.vue';
import Queue from './Queue.vue';

const route = useRoute();
const router = useRouter();
const showQueue = ref(false);

const { can, guestCan } = useSession();
const canControl = computed(() => can('player.control'));
const canTransport = computed(() => can('player.control') || guestCan('transport'));
const canSkip = computed(() => can('player.control') || guestCan('skip'));
const canModeCtl = computed(() => can('player.control') || guestCan('playMode'));

const store = usePlayerStore();
const activeBot = computed(() => store.activeBot);
const currentSong = computed(() => store.currentSong);
const showBotBadge = computed(() => store.bots.length > 1);

function toggleLyrics() {
  if (route.path === '/lyrics') {
    // Go back if there's history, otherwise go home
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push('/');
    }
  } else {
    router.push('/lyrics');
  }
}

// Progress — use manual timer instead of relying on reactive getters
const currentElapsed = ref(0);
const progressPercent = ref(0);
const progressTooltipVisible = ref(false);
const progressTooltipX = ref(0);
const progressTooltipTime = ref('0:00');
const progressBarRef = ref<HTMLElement | null>(null);
let rafId: number | null = null;

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const isDraggingProgress = ref(false);

function calculateProgressRatio(e: PointerEvent | MouseEvent): number {
  const bar = progressBarRef.value;
  if (!bar) return 0;
  const rect = bar.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

// P2-49 / 优化建议#10: 无歌曲、暂停或后台标签页时无需每帧重算并重渲染。原来的
// 循环无条件自我续帧，长驻页面会一直空转 60fps。只在真正需要时运行，条件恢复时
// 由 watch / visibilitychange 重启。
function shouldRunProgressClock(): boolean {
  return !!currentSong.value
    && store.isPlaying
    && !(typeof document !== 'undefined' && document.hidden);
}

function startProgressRaf() {
  if (rafId === null && shouldRunProgressClock()) rafId = requestAnimationFrame(updateProgress);
}

function stopProgressRaf() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function updateProgress() {
  rafId = null;
  // 条件不满足就停帧，界面保留最后一帧（暂停位置即冻结值）。
  if (!shouldRunProgressClock()) return;
  refreshProgressOnce();
  rafId = requestAnimationFrame(updateProgress);
}

/** One rAF tick of work, also usable as a one-shot when the loop is idle. */
function refreshProgressOnce() {
  // When the user is dragging the progress bar, do NOT overwrite the display.
  if (isDraggingProgress.value) return;
  // liveElapsed() (an action, not the cached `elapsed` getter) re-interpolates
  // from the server anchor on every frame so the clock ticks each second (#107).
  currentElapsed.value = store.liveElapsed();

  const duration = currentSong.value?.duration ?? 0;
  progressPercent.value = duration > 0
    ? Math.min((currentElapsed.value / duration) * 100, 100)
    : 0;
}

// 歌曲出现/切换、播放与暂停的切换会改变时钟是否需要运行。停止时补一次刷新，
// 让进度条对齐当前状态（例如暂停期间歌曲被其他客户端切走）。
watch([() => currentSong.value?.id, () => store.isPlaying], () => {
  if (shouldRunProgressClock()) startProgressRaf();
  else { stopProgressRaf(); refreshProgressOnce(); }
});

function onVisibilityChange() {
  if (shouldRunProgressClock()) startProgressRaf();
  else stopProgressRaf();
}

function onProgressPointerDown(e: PointerEvent) {
  if (!canTransport.value) return; // seek gated on transport (canTransport)
  isDraggingProgress.value = true;
  try {
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
  } catch { /* ignore */ }

  const ratio = calculateProgressRatio(e);
  const duration = currentSong.value?.duration ?? 0;
  progressPercent.value = ratio * 100;
  currentElapsed.value = ratio * duration;

  const bar = progressBarRef.value;
  if (bar) {
    progressTooltipVisible.value = true;
    progressTooltipX.value = e.clientX - bar.getBoundingClientRect().left;
    progressTooltipTime.value = formatTime(ratio * duration);
  }
}

function onProgressPointerMove(e: PointerEvent) {
  const bar = progressBarRef.value;
  if (!bar) return;
  const ratio = calculateProgressRatio(e);
  const duration = currentSong.value?.duration ?? 0;
  progressTooltipVisible.value = true;
  progressTooltipX.value = e.clientX - bar.getBoundingClientRect().left;
  progressTooltipTime.value = formatTime(ratio * duration);

  if (isDraggingProgress.value && canTransport.value) {
    progressPercent.value = ratio * 100;
    currentElapsed.value = ratio * duration;
  }
}

async function onProgressPointerUp(e: PointerEvent) {
  if (!isDraggingProgress.value) return;
  try {
    (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
  } catch { /* ignore */ }

  if (e.pointerType === 'touch') {
    progressTooltipVisible.value = false;
  }

  if (!canTransport.value) {
    isDraggingProgress.value = false;
    refreshProgressOnce();
    return;
  }
  const ratio = calculateProgressRatio(e);
  const duration = currentSong.value?.duration ?? 0;
  const seekTime = ratio * duration;
  try {
    await store.seek(seekTime);
  } finally {
    isDraggingProgress.value = false;
    // 时钟在暂停/隐藏时会停帧，这里补一次刷新：成功则对齐新位置，失败则回退。
    refreshProgressOnce();
  }
}

function onProgressPointerCancel(e: PointerEvent) {
  // P2-50: pointercancel（系统手势 / 来电 / 元素被抢占）的坐标是陈旧且无意义的，
  // 绝不能走 seek 提交路径——只做取消与复位，把进度条交回时钟。
  if (!isDraggingProgress.value) return;
  try {
    (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
  } catch { /* ignore */ }
  if (e.pointerType === 'touch') {
    progressTooltipVisible.value = false;
  }
  isDraggingProgress.value = false;
  // 取消后把进度条交回时钟（时钟停帧时也保证显示正确，而不是陈旧的拖拽位置）。
  refreshProgressOnce();
}

function onProgressMouseLeave() {
  if (!isDraggingProgress.value) {
    progressTooltipVisible.value = false;
  }
}

onMounted(() => {
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  startProgressRaf();
});

onUnmounted(() => {
  stopProgressRaf();
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
});

function togglePlay() {
  if (store.isPlaying) {
    store.pause();
  } else {
    store.resume();
  }
}

// Volume slider is decoupled from the per-frame rAF re-render so dragging the
// thumb isn't reset every frame (#111). See useDecoupledSlider.
const {
  display: volumeDisplay,
  onInput: onVolumeInput,
  onChange: onVolumeChange,
  onRelease: onVolumeRelease,
} = useDecoupledSlider(
  () => activeBot.value?.volume,
  (v) => store.setVolume(v)
);

const modeOrder = ['seq', 'loop', 'random', 'rloop'] as const;
const modeIcons: Record<string, string> = {
  seq: 'mdi:arrow-right',
  loop: 'mdi:repeat',
  random: 'mdi:shuffle',
  rloop: 'mdi:shuffle-variant',
};
const modeLabels: Record<string, string> = {
  seq: '顺序',
  loop: '循环',
  random: '随机',
  rloop: '随机循环',
};

const currentMode = computed(() => activeBot.value?.playMode ?? 'seq');
const modeIcon = computed(() => modeIcons[currentMode.value] ?? modeIcons.seq);
const modeLabel = computed(() => modeLabels[currentMode.value] ?? modeLabels.seq);

function cycleMode() {
  const idx = modeOrder.indexOf(currentMode.value as typeof modeOrder[number]);
  const next = modeOrder[(idx + 1) % modeOrder.length];
  store.setMode(next);
}
</script>

<style lang="scss" scoped>
.player-wrapper {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;

  @media (max-width: 768px) {
    display: none;
  }
}

.player-bar {
  height: var(--player-height);
  display: flex;
  align-items: center;
  padding: 0 24px;
  border-top: 1px solid var(--border-color);
  position: relative;
}

.progress-bar-container {
  position: absolute;
  top: -6px;
  left: 0;
  right: 0;
  height: 12px;
  cursor: pointer;
  z-index: 101;
  display: flex;
  align-items: center;
  touch-action: none;

  &:hover, &.is-dragging {
    .progress-bar-bg { height: 4px; }
    .progress-bar-thumb { opacity: 1; transform: scale(1); }
  }

  &.no-seek {
    cursor: default;
    &:hover {
      .progress-bar-bg { height: 2px; }
      .progress-bar-thumb { opacity: 0; transform: scale(0); }
    }
  }
}

.progress-bar-bg {
  width: 100%;
  height: 2px;
  background: var(--border-color);
  transition: height 0.15s ease;
  position: relative;
  border-radius: 1px;
}

.progress-bar-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--color-primary);
  border-radius: 1px;
  // No transition — updated via rAF for smooth movement
}

.progress-bar-thumb {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  background: var(--color-primary);
  border-radius: 50%;
  transform: scale(0);
  opacity: 0;
  transition: opacity 0.15s, transform 0.15s;
  margin-left: -5px;
  margin-top: -5px;
}

.progress-tooltip {
  position: absolute;
  top: -28px;
  transform: translateX(-50%);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  pointer-events: none;
}

.time-display {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
}

.time-current { text-align: right; }
.time-total { text-align: left; }

.player-left {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 240px;
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 0.8; }
}

.song-info {
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.song-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.artist-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.bot-badge {
  display: inline-block;
  font-size: var(--fs-micro);
  font-weight: var(--fw-semi);
  padding: 0 5px;
  background: var(--color-primary-15);
  color: var(--color-primary);
  border-radius: var(--radius-xs);
  line-height: 16px;
  white-space: nowrap;
  flex-shrink: 0;
}

.player-center {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 20px;
}

.control-btn {
  font-size: 20px;
  opacity: 0.7;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
  &.active { opacity: 1; color: var(--color-primary); }
}

.mode-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 18px;
}

.mode-label {
  font-size: 11px;
  font-weight: 500;
}

.play-btn {
  width: 32px;
  height: 32px;
  background: var(--color-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: white;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.08); }
  &:active { transform: scale(0.95); }
}

.player-right {
  width: 240px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.volume-icon {
  font-size: 18px;
  opacity: 0.6;
}

.volume-slider {
  width: 80px;
  height: 3px;
  appearance: none;
  background: var(--border-color);
  border-radius: 2px;
  outline: none;

  &::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--color-primary);
    border-radius: 50%;
    cursor: pointer;
  }
}

.lyrics-btn {
  margin-left: 8px;
}
</style>

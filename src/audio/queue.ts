export enum PlayMode {
  Sequential = "seq",
  Loop = "loop",
  Random = "random",
  RandomLoop = "rloop",
}

/**
 * Map a persisted / user-supplied play-mode string onto the PlayMode enum.
 *
 * SINGLE source of truth for both consumers: the persisted-value restore path
 * (BotInstance constructor) and the `!mode <value>` chat command. Accepts the
 * canonical values (seq/loop/random/rloop) plus the long aliases
 * (sequential/randomloop) that the chat command has always allowed, so a
 * hand-edited config.json and a chat command behave identically. Returns null
 * for anything unrecognized, which callers treat as "leave the mode alone".
 */
export function parsePlayMode(value: unknown): PlayMode | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "seq":
    case "sequential":
      return PlayMode.Sequential;
    case "loop":
      return PlayMode.Loop;
    case "random":
      return PlayMode.Random;
    case "rloop":
    case "randomloop":
      return PlayMode.RandomLoop;
    default:
      return null;
  }
}

export interface QueuedSong {
  id: string;
  name: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify" | "jellyfin";
  url?: string; // resolved lazily at play time
  coverUrl: string;
  duration: number; // seconds
  requestedBy?: string;
}

/**
 * A persistable view of a queue: its songs (minus the lazily-resolved `url`),
 * the current index, and the play mode. Used to snapshot/restore the live queue
 * across restarts (issue #119). Derived state (playedIndices/history/forward
 * stack) is intentionally NOT captured — restore() rebuilds it consistently.
 */
export interface QueueSnapshot {
  songs: Omit<QueuedSong, "url">[];
  currentIndex: number;
  mode: PlayMode;
}

export class PlayQueue {
  private songs: QueuedSong[] = [];
  private currentIndex = -1;
  private mode: PlayMode = PlayMode.Sequential;
  private playedIndices = new Set<number>();
  private history: number[] = [];
  private forwardStack: number[] = [];
  private nextRandomCandidate: number | null = null;
  private static readonly HISTORY_LIMIT = 50;

  private pushHistory(idx: number): void {
    if (idx < 0 || idx >= this.songs.length) return;
    this.history.push(idx);
    if (this.history.length > PlayQueue.HISTORY_LIMIT) {
      this.history.shift();
    }
  }

  add(song: QueuedSong): void {
    this.songs.push(song);
    this.nextRandomCandidate = null;
  }

  addMany(songs: QueuedSong[]): void {
    this.songs.push(...songs);
    this.nextRandomCandidate = null;
  }

  /**
   * Insert a song to play immediately after the current one. Falls
   * through to plain push when nothing is playing yet (currentIndex < 0
   * or queue empty), so the existing "add → idle bot starts playing"
   * flow continues to work.
   *
   * Shifts playedIndices, history and forwardStack entries > currentIndex
   * by +1 so their references stay valid after the splice.
   *
   * In the random modes the array position alone means nothing — next()
   * picks from the shuffle bag — so the insert slot is also recorded on
   * the forward stack, which next() consults first (issue #141).
   */
  addNext(song: QueuedSong): void {
    this.nextRandomCandidate = null;
    if (this.currentIndex < 0 || this.songs.length === 0) {
      this.songs.push(song);
      return;
    }
    const insertAt = this.currentIndex + 1;
    this.songs.splice(insertAt, 0, song);

    const shifted = new Set<number>();
    for (const i of this.playedIndices) {
      shifted.add(i > this.currentIndex ? i + 1 : i);
    }
    this.playedIndices = shifted;

    this.history = this.history.map((i) =>
      i > this.currentIndex ? i + 1 : i,
    );

    this.forwardStack = this.forwardStack.map((i) =>
      i > this.currentIndex ? i + 1 : i,
    );

    // Push AFTER the shift, or the slot we just claimed would be shifted
    // too. Stacking makes repeated !pn play in the order the queue shows
    // them (each insert lands in front of the previous one), matching what
    // sequential mode does with the same array. Bounded like history: drop the
    // OLDEST pending entry rather than refusing the newest, so the song the
    // user just asked for is always the one that gets honoured.
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      this.forwardStack.push(insertAt);
      if (this.forwardStack.length > PlayQueue.HISTORY_LIMIT) {
        this.forwardStack.shift();
      }
    }
  }

  remove(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.nextRandomCandidate = null;
    const [removed] = this.songs.splice(index, 1);

    // Removing the current entry — or anything before it — shifts every later
    // song down one slot, so step the pointer back: the next next() then lands
    // on the song that slid into the removed slot. (Both branches used to be
    // spelled out separately with identical bodies.)
    //
    // NOTE: this only keeps the QUEUE consistent. A caller that removes the
    // AUDIBLE track must also restart playback itself — see
    // BotCommandHandler.cmdRemove — because the queue cannot know whether the
    // removed song is the one currently coming out of the speakers.
    if (index <= this.currentIndex) {
      this.currentIndex--;
    }

    // Rebuild playedIndices to account for shifted indices
    const newPlayed = new Set<number>();
    for (const idx of this.playedIndices) {
      if (idx === index) continue;
      newPlayed.add(idx > index ? idx - 1 : idx);
    }
    this.playedIndices = newPlayed;

    // Same shift logic for history — drop entries pointing at the
    // removed song; shift entries > index down by 1.
    this.history = this.history
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    // …and for the forward stack, which now also carries !pn insert slots
    // (issue #141). Left unshifted, a removal elsewhere in the queue would
    // silently repoint the entry at whatever song slid into that slot.
    this.forwardStack = this.forwardStack
      .filter((idx) => idx !== index)
      .map((idx) => (idx > index ? idx - 1 : idx));

    return removed;
  }

  clear(): void {
    this.songs = [];
    this.currentIndex = -1;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    this.nextRandomCandidate = null;
  }

  play(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    this.nextRandomCandidate = null;
    this.currentIndex = 0;
    this.playedIndices.add(0);
    return this.songs[0];
  }

  playAt(index: number): QueuedSong | null {
    if (index < 0 || index >= this.songs.length) return null;
    this.pushHistory(this.currentIndex);
    // Reset the Random-mode "unplayed" pool — explicit picks restart
    // shuffle from this point. History tracking is independent and
    // unaffected by this clear.
    this.playedIndices.clear();
    this.forwardStack = [];
    this.nextRandomCandidate = null;
    this.currentIndex = index;
    this.playedIndices.add(index);
    return this.songs[index];
  }

  next(): QueuedSong | null {
    if (this.songs.length === 0) return null;

    switch (this.mode) {
      case PlayMode.Sequential: {
        const nextIndex = this.currentIndex + 1;
        if (nextIndex >= this.songs.length) return null;
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        return this.songs[nextIndex];
      }
      case PlayMode.Loop: {
        this.pushHistory(this.currentIndex);
        this.currentIndex = (this.currentIndex + 1) % this.songs.length;
        return this.songs[this.currentIndex];
      }
      case PlayMode.Random:
      case PlayMode.RandomLoop: {
        // 优先回到前进栈记录的位置（prev 退回的歌，或 !pn 插入的歌）。
        // Keep popping past entries that no longer point anywhere useful,
        // the way prev() walks past stale history entries. Without the loop a
        // prev() that pushed the current index would swallow the pending !pn
        // entry behind it. The range check is belt-and-braces — addNext and
        // remove keep the stack in sync — but an out-of-range index here would
        // set currentIndex out of bounds and hand back `undefined`, which
        // BotInstance.playNext reads as end-of-queue and stops playback.
        while (this.forwardStack.length > 0) {
          const target = this.forwardStack.pop()!;
          if (target < 0 || target >= this.songs.length) continue;
          if (target === this.currentIndex) continue;
          this.pushHistory(this.currentIndex);
          this.currentIndex = target;
          this.playedIndices.add(target);
          this.nextRandomCandidate = null;
          return this.songs[target];
        }

        // Shuffle bag: pick uniformly from the songs not yet played this
        // cycle, so every song plays once before any repeats (NetEase/QQ
        // style). Songs added mid-cycle aren't in playedIndices, so they're
        // naturally eligible within the current cycle.
        const unplayed: number[] = [];
        for (let i = 0; i < this.songs.length; i++) {
          if (!this.playedIndices.has(i)) unplayed.push(i);
        }

        if (unplayed.length === 0) {
          // Cycle complete.
          if (this.mode === PlayMode.Random) {
            this.nextRandomCandidate = null;
            return null; // 随机：播完即停
          }
          // 随机循环：reshuffle and keep going forever.
          if (this.songs.length === 1) {
            this.pushHistory(this.currentIndex);
            this.currentIndex = 0;
            this.playedIndices = new Set([0]);
            this.nextRandomCandidate = null;
            return this.songs[0];
          }
          // Start a fresh cycle: every song is eligible again, but exclude
          // the song that just played from THIS pick only, so it doesn't
          // repeat back-to-back across the boundary. It stays eligible for
          // the rest of the new cycle, so every song still plays exactly once.
          this.playedIndices = new Set();
          for (let i = 0; i < this.songs.length; i++) {
            if (i !== this.currentIndex) unplayed.push(i);
          }
        }

        let nextIndex: number;
        if (this.nextRandomCandidate !== null && unplayed.includes(this.nextRandomCandidate)) {
          nextIndex = this.nextRandomCandidate;
        } else {
          nextIndex = unplayed[Math.floor(Math.random() * unplayed.length)];
        }
        this.nextRandomCandidate = null;
        this.pushHistory(this.currentIndex);
        this.currentIndex = nextIndex;
        this.playedIndices.add(nextIndex);
        return this.songs[nextIndex];
      }
    }
  }

  prev(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    this.nextRandomCandidate = null;

    // 记录当前位置到前进栈，供 next 优先返回
    if (this.currentIndex >= 0 && this.forwardStack.length < PlayQueue.HISTORY_LIMIT) {
      this.forwardStack.push(this.currentIndex);
    }

    // Preferred: pop from the back-stack so prev means "the song I
    // actually played before this one," not "the previous array slot."
    while (this.history.length > 0) {
      const idx = this.history.pop()!;
      if (idx >= 0 && idx < this.songs.length) {
        this.currentIndex = idx;
        this.playedIndices = new Set([...this.history, this.currentIndex]);
        return this.songs[idx];
      }
      // Stale entry (song removed) — keep popping.
    }

    // Fallback: no history to walk back through. In Sequential we
    // can still meaningfully step the index backward; in random
    // modes there's nothing useful to return.
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      return null;
    }
    const prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.mode === PlayMode.Sequential) return null;
      this.currentIndex = this.songs.length - 1;
    } else {
      this.currentIndex = prevIndex;
    }
    this.playedIndices.add(this.currentIndex);
    return this.songs[this.currentIndex];
  }

  current(): QueuedSong | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.songs.length)
      return null;
    return this.songs[this.currentIndex];
  }

  /** Look ahead at the next song to be played without advancing the queue pointer. */
  peekNext(): QueuedSong | null {
    if (this.songs.length === 0) return null;
    if (this.mode === PlayMode.Sequential) {
      const nextIndex = this.currentIndex + 1;
      return nextIndex < this.songs.length ? this.songs[nextIndex] : null;
    }
    if (this.mode === PlayMode.Loop) {
      const nextIndex = (this.currentIndex + 1) % this.songs.length;
      return this.songs[nextIndex] ?? null;
    }
    if (this.mode === PlayMode.Random || this.mode === PlayMode.RandomLoop) {
      if (this.forwardStack.length > 0) {
        for (let i = this.forwardStack.length - 1; i >= 0; i--) {
          const target = this.forwardStack[i];
          if (target >= 0 && target < this.songs.length && target !== this.currentIndex) {
            return this.songs[target];
          }
        }
      }
      const unplayed: number[] = [];
      for (let i = 0; i < this.songs.length; i++) {
        if (!this.playedIndices.has(i) && i !== this.currentIndex) {
          unplayed.push(i);
        }
      }
      if (unplayed.length > 0) {
        if (this.nextRandomCandidate !== null && unplayed.includes(this.nextRandomCandidate)) {
          return this.songs[this.nextRandomCandidate];
        }
        this.nextRandomCandidate = unplayed[Math.floor(Math.random() * unplayed.length)];
        return this.songs[this.nextRandomCandidate];
      }
      if (this.mode === PlayMode.RandomLoop && this.songs.length > 0) {
        const candidates = this.songs
          .map((_, i) => i)
          .filter((i) => i !== this.currentIndex);
        if (candidates.length === 0) return this.songs[0];
        if (this.nextRandomCandidate !== null && candidates.includes(this.nextRandomCandidate)) {
          return this.songs[this.nextRandomCandidate];
        }
        this.nextRandomCandidate = candidates[Math.floor(Math.random() * candidates.length)];
        return this.songs[this.nextRandomCandidate];
      }
    }
    return null;
  }

  list(): QueuedSong[] {
    return [...this.songs];
  }

  size(): number {
    return this.songs.length;
  }

  isEmpty(): boolean {
    return this.songs.length === 0;
  }

  getMode(): PlayMode {
    return this.mode;
  }

  setMode(mode: PlayMode): void {
    this.mode = mode;
    this.playedIndices.clear();
    this.history = [];
    this.forwardStack = [];
    this.nextRandomCandidate = null;
    if (this.currentIndex >= 0) {
      this.playedIndices.add(this.currentIndex);
    }
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  /** Number of songs not yet played in Random mode. */
  unplayedCount(): number {
    return this.songs.length - this.playedIndices.size;
  }

  /**
   * Capture the queue as a persistable snapshot (songs minus `url`, current
   * index, mode). Songs keep their `requestedBy` so restored play-history
   * attribution stays correct. See restore().
   */
  snapshot(): QueueSnapshot {
    return {
      songs: this.songs.map(({ url: _url, ...s }) => s),
      currentIndex: this.currentIndex,
      mode: this.mode,
    };
  }

  /**
   * Replace the queue contents from a snapshot. Rebuilds the derived
   * playedIndices/history/forwardStack to a clean, consistent state for the
   * restored index (an out-of-range index degrades to -1 = "nothing current").
   */
  restore(s: QueueSnapshot): void {
    this.songs = s.songs.map((song) => ({ ...song }));
    this.mode = s.mode;
    this.currentIndex =
      s.currentIndex >= 0 && s.currentIndex < this.songs.length ? s.currentIndex : -1;
    this.playedIndices = new Set(this.currentIndex >= 0 ? [this.currentIndex] : []);
    this.history = [];
    this.forwardStack = [];
    this.nextRandomCandidate = null;
  }
}

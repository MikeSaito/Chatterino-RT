// Viewport offset for the Pixi ring. Behavior follows Chatterino ChannelView
// plus Scrollbar relative current value (MIT; no Qt/C++ copied).

export type ScrollAnchor = {
  msgId: string;
  offsetFrac: number;
};

export type LaidSlot = {
  msgId: string;
  startRow: number;
  lineCount: number;
};

export type ScrollSnapshot = {
  desired: number;
  /** Display position (smooth); thumb paint uses this. */
  current: number;
  bottom: number;
  atBottom: boolean;
  overflow: boolean;
  contentRows: number;
  viewRows: number;
};

const EPS = 1e-3;
export const SMOOTH_SCROLL_MS = 150;

export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export class ScrollModel {
  desired = 0;
  current = 0;
  atBottom = true;
  contentRows = 0;
  viewRows = 0;

  private smoothEnabled = true;
  private smoothNewMessages = false;
  private animating = false;
  private animFrom = 0;
  private animTo = 0;
  private animStart = 0;

  configureSmooth(opts: { enabled: boolean; newMessages: boolean }): void {
    this.smoothEnabled = opts.enabled;
    this.smoothNewMessages = opts.newMessages;
    if (!this.smoothEnabled) {
      this.snapCurrent();
    }
  }

  isSmoothEnabled(): boolean {
    return this.smoothEnabled;
  }

  bottom(): number {
    return Math.max(0, this.contentRows - this.viewRows);
  }

  overflow(): boolean {
    return this.contentRows > this.viewRows + EPS;
  }

  isAnimating(): boolean {
    return this.animating;
  }

  snapshot(): ScrollSnapshot {
    return {
      desired: this.desired,
      current: this.current,
      bottom: this.bottom(),
      atBottom: this.atBottom,
      overflow: this.overflow(),
      contentRows: this.contentRows,
      viewRows: this.viewRows,
    };
  }

  reset(): void {
    this.desired = 0;
    this.current = 0;
    this.atBottom = true;
    this.contentRows = 0;
    this.viewRows = 0;
    this.animating = false;
  }

  goToBottom(animated?: boolean): void {
    this.atBottom = true;
    this.desired = this.bottom();
    this.finish(true);
    const anim = (animated ?? this.smoothNewMessages) && this.smoothEnabled;
    this.startOrRetarget(anim);
  }

  setDesired(value: number, animated = false): void {
    this.atBottom = false;
    this.desired = value;
    this.finish();
    this.startOrRetarget(animated && this.smoothEnabled);
  }

  wheel(deltaRows: number, animated = false): void {
    if (!this.overflow()) {
      this.atBottom = true;
      this.desired = 0;
      this.startOrRetarget(false);
      return;
    }
    this.setDesired(this.desired + deltaRows, animated);
  }

  private startOrRetarget(animated: boolean): void {
    if (!animated) {
      this.snapCurrent();
      return;
    }
    this.animFrom = this.current;
    this.animTo = this.desired;
    this.animStart = -1;
    this.animating = Math.abs(this.animTo - this.animFrom) > EPS;
    if (!this.animating) {
      this.current = this.desired;
    }
  }

  /** Advance tween; returns true if still animating. */
  tick(now: number): boolean {
    if (!this.animating) {
      this.current = this.desired;
      return false;
    }
    if (this.animStart < 0) {
      this.animStart = now;
    }
    const t = (now - this.animStart) / SMOOTH_SCROLL_MS;
    if (t >= 1) {
      this.current = this.desired;
      this.animating = false;
      return false;
    }
    const e = easeOutCubic(t);
    this.current = this.animFrom + (this.animTo - this.animFrom) * e;
    return true;
  }

  /**
   * Snapshot a scroll position against laid rows.
   * `atRows` defaults to desired; pass `current` to stabilize the visible frame
   * while a smooth tween is in flight.
   */
  captureAnchor(
    slots: readonly LaidSlot[],
    atRows?: number,
  ): ScrollAnchor | undefined {
    if (atRows === undefined && this.atBottom) {
      return undefined;
    }
    const y = atRows ?? this.desired;
    for (const slot of slots) {
      if (slot.msgId.length === 0 || slot.lineCount <= 0) {
        continue;
      }
      const end = slot.startRow + slot.lineCount;
      if (y + EPS < slot.startRow) {
        break;
      }
      if (y < end - EPS) {
        return {
          msgId: slot.msgId,
          offsetFrac: (y - slot.startRow) / slot.lineCount,
        };
      }
    }
    return undefined;
  }

  /** Map an anchor onto current laid geometry; undefined if the message is gone. */
  resolveAnchor(
    slots: readonly LaidSlot[],
    anchor: ScrollAnchor | undefined,
  ): number | undefined {
    if (!anchor) {
      return undefined;
    }
    const found = slots.find((slot) => slot.msgId === anchor.msgId);
    if (!found || found.lineCount <= 0) {
      return undefined;
    }
    const frac = Math.min(1, Math.max(0, anchor.offsetFrac));
    return found.startRow + frac * found.lineCount;
  }

  /**
   * @param visualAnchor - pre-mutation anchor for the painted frame (`current`).
   *   Omit to leave current alone except desired-delta compensation while animating.
   *   Pass explicitly (including `undefined` via `glueVisual=true`) from ring sealed pairs.
   * @param glueVisual - when true, apply `visualAnchor` (or desired-delta if unresolved).
   * @param followSmooth - when false, stick-to-bottom growth snaps (snapshot / geometry /
   *   channel-open settle). Live appends pass true so smooth-new-messages still works.
   */
  applyLayout(
    contentRows: number,
    viewRows: number,
    slots: readonly LaidSlot[],
    anchor: ScrollAnchor | undefined,
    paused = false,
    visualAnchor?: ScrollAnchor,
    glueVisual = false,
    followSmooth = true,
  ): void {
    const prevBottom = this.bottom();
    const prevContent = this.contentRows;
    const prevDesired = this.desired;
    const prevCurrent = this.current;
    const wasFollowing = this.atBottom;
    const wasAnimating = this.animating;
    this.contentRows = Math.max(0, contentRows);
    this.viewRows = Math.max(0, viewRows);
    if (paused) {
      this.atBottom = false;
      if (anchor) {
        const next = this.resolveAnchor(slots, anchor);
        if (next !== undefined) {
          this.desired = next;
        } else if (wasFollowing) {
          this.desired = prevBottom;
        }
      } else if (wasFollowing) {
        this.desired = prevBottom;
      }
      this.stabilizeCurrent(
        slots,
        visualAnchor,
        glueVisual,
        wasFollowing,
        wasAnimating,
        prevDesired,
        prevCurrent,
      );
      this.finish(false);
      this.clampCurrent();
      if (wasAnimating && this.smoothEnabled) {
        this.startOrRetarget(true);
      } else {
        this.startOrRetarget(false);
      }
      return;
    }
    if (!this.atBottom && anchor) {
      const next = this.resolveAnchor(slots, anchor);
      if (next !== undefined) {
        this.desired = next;
      } else {
        this.desired = 0;
      }
    }
    this.stabilizeCurrent(
      slots,
      visualAnchor,
      glueVisual,
      wasFollowing,
      wasAnimating,
      prevDesired,
      prevCurrent,
    );
    this.finish(true);
    this.clampCurrent();
    const grewWhileFollowing =
      followSmooth &&
      wasFollowing &&
      this.atBottom &&
      this.smoothNewMessages &&
      this.smoothEnabled &&
      prevContent > 0 &&
      Math.abs(this.current - this.desired) > EPS;
    if (grewWhileFollowing) {
      this.startOrRetarget(true);
    } else if (wasAnimating && this.smoothEnabled && !this.atBottom) {
      this.startOrRetarget(true);
    } else {
      this.snapCurrent();
    }
  }

  stageY(lineHeight: number): number {
    if (!this.overflow()) {
      return 0;
    }
    return -this.current * lineHeight;
  }

  private stabilizeCurrent(
    slots: readonly LaidSlot[],
    visualAnchor: ScrollAnchor | undefined,
    glueVisual: boolean,
    wasFollowing: boolean,
    wasAnimating: boolean,
    prevDesired: number,
    prevCurrent: number,
  ): void {
    if (wasFollowing || this.atBottom) {
      return;
    }
    // Painted frame only drifts from desired during a tween (or pause mid-tween).
    if (!wasAnimating && !glueVisual) {
      return;
    }
    if (glueVisual) {
      const next = this.resolveAnchor(slots, visualAnchor);
      if (next !== undefined) {
        this.current = next;
        return;
      }
      // Visual message evicted: keep the frame via the same content delta as desired.
      this.current = prevCurrent + (this.desired - prevDesired);
      return;
    }
    if (wasAnimating) {
      this.current = prevCurrent + (this.desired - prevDesired);
    }
  }

  private clampCurrent(): void {
    const b = this.bottom();
    if (b <= EPS) {
      this.current = 0;
      return;
    }
    this.current = Math.min(Math.max(0, this.current), b);
  }

  private snapCurrent(): void {
    this.animating = false;
    this.current = this.desired;
  }

  private finish(allowSnapToBottom = true): void {
    const b = this.bottom();
    if (b <= EPS) {
      this.desired = 0;
      if (allowSnapToBottom) {
        this.atBottom = true;
      }
      return;
    }
    this.desired = Math.min(Math.max(0, this.desired), b);
    if (allowSnapToBottom && (this.atBottom || this.desired >= b - EPS)) {
      this.desired = b;
      this.atBottom = true;
    }
  }
}

export function wheelDeltaRows(
  deltaY: number,
  deltaMode: number,
  lineHeight: number,
  viewRows: number,
): number {
  if (lineHeight <= 0) {
    return 0;
  }
  if (deltaMode === 1) {
    return deltaY;
  }
  if (deltaMode === 2) {
    return deltaY * Math.max(1, viewRows);
  }
  return deltaY / lineHeight;
}

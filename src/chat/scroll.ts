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
  bottom: number;
  atBottom: boolean;
  overflow: boolean;
  contentRows: number;
  viewRows: number;
};

const EPS = 1e-3;

export class ScrollModel {
  desired = 0;
  atBottom = true;
  contentRows = 0;
  viewRows = 0;

  bottom(): number {
    return Math.max(0, this.contentRows - this.viewRows);
  }

  overflow(): boolean {
    return this.contentRows > this.viewRows + EPS;
  }

  snapshot(): ScrollSnapshot {
    return {
      desired: this.desired,
      bottom: this.bottom(),
      atBottom: this.atBottom,
      overflow: this.overflow(),
      contentRows: this.contentRows,
      viewRows: this.viewRows,
    };
  }

  reset(): void {
    this.desired = 0;
    this.atBottom = true;
    this.contentRows = 0;
    this.viewRows = 0;
  }

  goToBottom(): void {
    this.atBottom = true;
    this.desired = this.bottom();
  }

  setDesired(value: number): void {
    this.atBottom = false;
    this.desired = value;
    this.finish();
  }

  wheel(deltaRows: number): void {
    if (!this.overflow()) {
      this.atBottom = true;
      this.desired = 0;
      return;
    }
    this.setDesired(this.desired + deltaRows);
  }

  captureAnchor(slots: readonly LaidSlot[]): ScrollAnchor | undefined {
    if (this.atBottom) {
      return undefined;
    }
    const y = this.desired;
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

  applyLayout(
    contentRows: number,
    viewRows: number,
    slots: readonly LaidSlot[],
    anchor: ScrollAnchor | undefined,
    paused = false,
  ): void {
    const prevBottom = this.bottom();
    const wasFollowing = this.atBottom;
    this.contentRows = Math.max(0, contentRows);
    this.viewRows = Math.max(0, viewRows);
    if (paused) {
      this.atBottom = false;
      if (anchor) {
        const found = slots.find((slot) => slot.msgId === anchor.msgId);
        if (found && found.lineCount > 0) {
          const frac = Math.min(1, Math.max(0, anchor.offsetFrac));
          this.desired = found.startRow + frac * found.lineCount;
        } else if (wasFollowing) {
          this.desired = prevBottom;
        }
      } else if (wasFollowing) {
        this.desired = prevBottom;
      }
      this.finish(false);
      return;
    }
    if (!this.atBottom && anchor) {
      const found = slots.find((slot) => slot.msgId === anchor.msgId);
      if (found && found.lineCount > 0) {
        const frac = Math.min(1, Math.max(0, anchor.offsetFrac));
        this.desired = found.startRow + frac * found.lineCount;
      } else {
        this.desired = 0;
      }
    }
    this.finish(true);
  }

  stageY(lineHeight: number): number {
    if (!this.overflow()) {
      return 0;
    }
    return -this.desired * lineHeight;
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

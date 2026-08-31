/**
 * Mount bootstrap gate for chat IPC (P1).
 * While mounting, live Channel batches must stay queued until snapshot applies.
 * Leaf module — safe for Node strip-types tests.
 */

export type MountBootstrapGate = {
  /** Enter mount: lastSeq cleared, live processing held. */
  begin: () => void;
  /** Leave mount (success or fail); pump may drain queued live. */
  end: () => void;
  /** True while bootstrap snapshot is in flight. */
  isHolding: () => boolean;
  /** Reset on clearActive / stop. */
  clear: () => void;
};

export function createMountBootstrapGate(): MountBootstrapGate {
  let mounting = false;
  return {
    begin: () => {
      mounting = true;
    },
    end: () => {
      mounting = false;
    },
    isHolding: () => mounting,
    clear: () => {
      mounting = false;
    },
  };
}

/**
 * Decide how a live batch interacts with seq state after mount completes.
 * `lastSeq === 0` only bootstraps via snapshot; contiguous/gap apply afterward.
 */
export function liveBatchAction(
  lastSeq: number,
  batchSeq: number,
  dropped: number,
): "stale" | "apply" | "gap" {
  if (batchSeq <= lastSeq) {
    return "stale";
  }
  const gapped = lastSeq !== 0 && batchSeq !== lastSeq + 1;
  if (gapped || dropped > 0) {
    return "gap";
  }
  return "apply";
}

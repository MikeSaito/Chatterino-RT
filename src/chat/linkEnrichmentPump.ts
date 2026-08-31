/**
 * Coalescing enrichment pump: generation cancels only on stop, never per-batch.
 * Leaf module for Node strip-types tests (no Tauri / ring / i18n imports).
 */

/** Cap concurrent Helix/title resolves so batches coalesce without stampede. */
export const LINK_ENRICH_MAX_INFLIGHT = 4;
/** Hard cap FIFO depth so snapshot/burst cannot grow pending without bound. */
export const LINK_ENRICH_MAX_PENDING = 256;

export type LinkEnrichmentPump = {
  afterIds: (ids: readonly string[]) => void;
  stop: () => void;
  pendingCount: () => number;
  inflightCount: () => number;
};

export type LinkEnrichmentPumpOpts = {
  maxInflight?: number;
  maxPending?: number;
  /** Return true if id still needs enrichment (in ring, not yet done). */
  isEligible: (id: string) => boolean;
  /**
   * Perform resolve+apply. `isCurrent` is false after stop() — abandon apply.
   * Do not cancel mid-resolve for newer batches; only stop/unmount.
   */
  enrich: (id: string, isCurrent: () => boolean) => Promise<void>;
};

export function createLinkEnrichmentPump(
  opts: LinkEnrichmentPumpOpts,
): LinkEnrichmentPump {
  const maxInflight = opts.maxInflight ?? LINK_ENRICH_MAX_INFLIGHT;
  const maxPending = opts.maxPending ?? LINK_ENRICH_MAX_PENDING;
  let generation = 0;
  const pending: string[] = [];
  const pendingSet = new Set<string>();
  const inflight = new Set<string>();

  const pump = (): void => {
    let i = 0;
    while (inflight.size < maxInflight && i < pending.length) {
      const id = pending[i];
      if (inflight.has(id)) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      pendingSet.delete(id);
      if (!opts.isEligible(id)) {
        continue;
      }
      inflight.add(id);
      const gen = generation;
      void opts.enrich(id, () => gen === generation).finally(() => {
        inflight.delete(id);
        // Always drain: after stop()+re-enqueue, cancelled jobs must unblock new work.
        pump();
      });
    }
  };

  const dropOldestPending = (): void => {
    while (pending.length >= maxPending) {
      const dropped = pending.shift();
      if (dropped !== undefined) {
        pendingSet.delete(dropped);
      }
    }
  };

  const enqueue = (msgId: string): void => {
    if (pendingSet.has(msgId)) {
      return;
    }
    // Keep a follow-up slot even while inflight (stop()+re-enqueue must not starve).
    if (inflight.has(msgId)) {
      dropOldestPending();
      pendingSet.add(msgId);
      pending.push(msgId);
      return;
    }
    if (!opts.isEligible(msgId)) {
      return;
    }
    dropOldestPending();
    pendingSet.add(msgId);
    pending.push(msgId);
  };

  return {
    afterIds: (ids) => {
      for (const id of ids) {
        enqueue(id);
      }
      pump();
    },
    stop: () => {
      generation += 1;
      pending.length = 0;
      pendingSet.clear();
    },
    pendingCount: () => pending.length,
    inflightCount: () => inflight.size,
  };
}

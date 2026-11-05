export type ViewBinding<Owner, View> = {
  readonly owner: Owner;
  readonly view: View;
  readonly token: symbol;
};

type ViewLifecycle<Owner, View> = {
  create: () => View;
  bind: (owner: Owner, view: View, token: symbol) => void;
  unbind: (owner: Owner, view: View) => void;
  destroy: (view: View) => void;
};

export class ViewPool<Owner, View extends object> {
  private readonly byOwner = new Map<Owner, ViewBinding<Owner, View>>();
  private readonly byView = new Map<View, ViewBinding<Owner, View>>();
  private readonly allocated = new Set<View>();
  private readonly free: View[] = [];
  private readonly wanted = new Set<Owner>();

  private readonly lifecycle: ViewLifecycle<Owner, View>;

  constructor(lifecycle: ViewLifecycle<Owner, View>) {
    this.lifecycle = lifecycle;
  }

  get views(): ReadonlySet<View> { return this.allocated; }
  get bindings(): ReadonlyMap<Owner, ViewBinding<Owner, View>> { return this.byOwner; }

  get(owner: Owner): View | undefined { return this.byOwner.get(owner)?.view; }
  ownerOf(view: View): Owner | undefined { return this.byView.get(view)?.owner; }
  tokenOf(owner: Owner): symbol | undefined { return this.byOwner.get(owner)?.token; }
  owns(owner: Owner, view: View, token: symbol | undefined): boolean {
    const binding = this.byOwner.get(owner);
    return !!binding && binding.view === view && binding.token === token;
  }

  private acquire(owner: Owner): View {
    const current = this.get(owner);
    if (current !== undefined) return current;
    const view = this.free.pop() ?? this.lifecycle.create();
    this.allocated.add(view);
    const binding = { owner, view, token: Symbol() };
    this.byOwner.set(owner, binding);
    this.byView.set(view, binding);
    try {
      this.lifecycle.bind(owner, view, binding.token);
    } catch (error) {
      this.release(owner);
      throw error;
    }
    return view;
  }

  release(owner: Owner): void {
    const binding = this.byOwner.get(owner);
    if (!binding) return;
    // Invalidate the lease before cleanup can complete pending work.
    this.byOwner.delete(owner);
    this.byView.delete(binding.view);
    try {
      this.lifecycle.unbind(owner, binding.view);
    } finally {
      this.free.push(binding.view);
    }
  }

  sync(owners: Iterable<Owner>, spare = 8): void {
    this.wanted.clear();
    for (const owner of owners) this.wanted.add(owner);
    for (const owner of this.byOwner.keys()) {
      if (!this.wanted.has(owner)) this.release(owner);
    }
    for (const owner of this.wanted) this.acquire(owner);
    const limit = this.byOwner.size + Math.max(0, Math.floor(spare));
    while (this.allocated.size > limit && this.free.length > 0) {
      const view = this.free.pop()!;
      this.allocated.delete(view);
      this.lifecycle.destroy(view);
    }
    this.wanted.clear();
  }

  clear(spare = 8): void { this.sync([], spare); }
  destroy(): void { this.clear(0); }
}

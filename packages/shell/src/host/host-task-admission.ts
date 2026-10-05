/** Installed task RPC admission only; not an inventory of tools or native resources. */
export class HostTaskAdmission {
  private sealed = false;
  private readonly pending = new Set<Promise<void>>();

  seal(): void { this.sealed = true; }

  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(Error("task-host-closing"));
    let release!: () => void;
    const terminal = new Promise<void>((resolve) => { release = resolve; });
    this.pending.add(terminal);
    const finish = () => { this.pending.delete(terminal); release(); };
    try {
      // Register before invoking work: callbacks can synchronously seal admission.
      const result = Promise.resolve(work());
      void result.then(finish, finish);
      return result;
    } catch (error) { finish(); return Promise.reject(error); }
  }

  async drain(): Promise<void> {
    if (!this.sealed) throw Error("task-host-not-sealed");
    // No new admission can join after sealing; operation refusal is still settlement.
    await Promise.all([...this.pending]);
  }
}

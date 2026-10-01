/** A deadline bounds the receipt, not the lifetime of the underlying work. */
export function shutdownDeadline<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) throw Error("invalid-shutdown-deadline");
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(code)), timeoutMs);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

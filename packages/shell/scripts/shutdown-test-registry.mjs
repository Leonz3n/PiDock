// Test-only cleanup helper for smoke harnesses (never imported from
// production). The sealed PerTaskHostRegistry contract allows disposeAll()
// only after the attested human quitAll() confirmed Host shutdown; this
// keeps that order and returns every cleanup failure for explicit
// recording instead of leaking unhandled rejections or weakening the
// product shutdown semantics. Callers supply their real or test-synthetic
// attested origin; with none available the helper records a skip.
export async function shutdownTestRegistry(registry, { origin, label }) {
  const failures = [];
  if (!registry) return failures;
  // Without an attested caller origin there is no honest quitAll seam. Record
  // the skip rather than fabricating an origin or attempting disposeAll.
  if (!origin) {
    failures.push("skipped: no attested origin");
    return failures;
  }
  try {
    const report = await registry.quitAll({ origin, label });
    if (!report.ok) failures.push(`quitAll not confirmed: ${JSON.stringify(report)}`);
  } catch (error) {
    failures.push(`quitAll: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await registry.disposeAll();
  } catch (error) {
    failures.push(`disposeAll: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}

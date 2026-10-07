/** Fixture observation only. Root/helper exit and a self-completion marker
 * never prove tree drain. A missing marker is required only for a known child.
 */
export function fixtureDisposition({ snapshot, descendant, descendantPid, deadlineAt }) {
  const driver = snapshot(), child = descendant(), childPid = descendantPid() ?? child?.pid;
  const missingReceipts = [];
  if ((driver.rootPid !== undefined || (driver.workerPid !== undefined && driver.reason !== "preflight-unavailable")) && !driver.ptyExit) missingReceipts.push("root-exit");
  if ((driver.workerPid !== undefined || driver.rootPid !== undefined) && !driver.workerExit) missingReceipts.push("worker-exit");
  if (childPid !== undefined && (!child || child.pid !== childPid || !child.exited)) missingReceipts.push("descendant-fixture-completion");
  return { driver, descendant: child, missingReceipts, deadlineExceeded: performance.now() >= deadlineAt, treeDrained: false };
}

export async function observeFixtureDisposition(options) {
  for (;;) {
    const result = fixtureDisposition(options);
    if (result.missingReceipts.length === 0 || result.deadlineExceeded) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, options.deadlineAt - performance.now()))));
  }
}

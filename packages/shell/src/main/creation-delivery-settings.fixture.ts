/**
 * [Pencil T13] #148b test fixture: the workspace Git delivery settings a real
 * creation reads.
 *
 * A worktree creation names its task branch through the SAVED convention and
 * refuses by name when it is unset (#148 kept "no silent default"), so every
 * fixture that creates a task must save a convention + remote first. The
 * template `task/{taskId}` keeps the historical `task/task-xxxxxxxx` spelling
 * those suites assert on, and `origin` is the remote every fixture configures.
 */

import { saveDeliverySettings, type StoredDeliverySettings } from "./git-delivery.js";

export const TEST_DELIVERY_BRANCH_TEMPLATE = "task/{taskId}";
export const TEST_DELIVERY_REMOTE = "origin";

/** Save the fixture's convention/remote into `profile` (throws if invalid). */
export function saveTestDeliverySettings(
  profile: string,
  input: { branchTemplate?: string; remote?: string } = {},
): StoredDeliverySettings {
  const saved = saveDeliverySettings(profile, {
    branchTemplate: input.branchTemplate ?? TEST_DELIVERY_BRANCH_TEMPLATE,
    remote: input.remote ?? TEST_DELIVERY_REMOTE,
  });
  if (!saved.ok) throw new Error(`fixture delivery settings refused: ${saved.code}: ${saved.message}`);
  return saved.settings;
}

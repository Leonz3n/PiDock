/**
 * [Pencil T06] ticket 141 跨任务共享真实路径的写协调，界面上必须说出的事实。
 *
 * 这一层**只在真实接线完成后**才说话：Host 现在把每个共享真实路径的受管写入同时
 * 记进进程内表与（`<userData>/shared-path-locks` 下的）应用私有原子锁，所以两个
 * **真实 Host 进程**写同一真实路径或互为祖先／后代时互斥，互不重叠仍并行。
 *
 * 三件事必须与代码同时成立，缺一就不得显示：
 * 1. 受管保护的范围是**受管写入**（PiDock 自己发出的任务工具写入），键 = `realpath`
 *    解析后的真实路径与祖先／后代重叠，不是任务 ID、词法路径或链接名；
 * 2. 被拒时 Host 说明**实际持有者**（任务／会话／Host 实例／进程与已持续时间）；持有者
 *    进程可证明已不存在时按 `lock-owner-dead` 具名恢复并保留凭据，不静默强夺；
 * 3. 外部编辑器的写入**不受**此约束（ADR 0006 的明确豁免）。这句话不能省，否则「受管
 *    保护」会被读成「文件已被 fence」。
 *
 * 这里不产生任何状态、不判断「谁在编辑」、也没有绿色安全徽标：它是一句随事实走的
 * 文案，读数（持有者／拒绝／恢复）来自 Host 自己的记录与拒绝文本。
 */

/** 受管保护的准确边界：管什么、不管什么、被拒时说什么。 */
export const SHARED_DIR_MANAGED_PROTECTION =
  "受管保护：PiDock 的受管写入按解析后的真实路径（含祖先／后代重叠）在任务之间与 Host 进程之间互斥；" +
  "被拒时 Host 说明实际持有者（任务／会话／Host 实例），持有者进程可证明已不存在时按 lock-owner-dead 具名恢复并保留凭据。" +
  "外部编辑器的写入不受此约束（ADR 0006）——PiDock 不会因为它开着而暂停自己的写入，也不会把这种情况报告成已隔离。";

/** 一句话版本，给紧凑的行内说明用。 */
export const SHARED_DIR_MANAGED_PROTECTION_SHORT =
  "受管写入按真实路径跨任务／跨 Host 进程互斥；外部编辑器写入不受此约束（ADR 0006）";

/**
 * 一段 Host 拒绝文本 → 读者能行动的一句话。恢复与「不静默强夺」必须写出来，
 * 未识别的拒绝一律保留 Host 原文，不改写成成功或「已保护」。
 */
export function sharedDirRefusalText(error: string | undefined): string | null {
  const value = (error ?? "").trim();
  if (value.length === 0) return null;
  if (value.startsWith("shared-path-locked")) {
    return `写入未执行：${value.replace(/^shared-path-locked:\s*/, "")}`;
  }
  if (value.startsWith("lock-owner-dead")) {
    return `已按具名恢复接管失效持有者的锁：${value.replace(/^lock-owner-dead:\s*/, "")}`;
  }
  if (value.startsWith("shared-path-lock-unreadable")) {
    return `写入未执行：锁记录不可读取，无法确认持有者，不静默强夺（${value.replace(/^shared-path-lock-unreadable:\s*/, "")}）`;
  }
  if (value.startsWith("shared-path-lock-unavailable")) {
    return `写入未执行：共享路径锁不可用，未在未取得互斥的情况下继续（${value.replace(/^shared-path-lock-unavailable:\s*/, "")}）`;
  }
  return `Host 拒绝：${value}`;
}

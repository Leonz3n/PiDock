/**
 * [Pencil T10] #145 历史里的引用来源芯片。
 *
 * 引用不会以正文形式上传：Host 把身份清单拼成一段固定尾注（`sdk-prompt-context`
 * 的 `composePromptContext`），模型看到的是身份，文件内容由 Agent 自己的工具读取。
 * 因此历史里那条用户消息的文字包含这段尾注。这里把它拆出来单独渲染为来源芯片：
 *
 * - 正文保持用户实际输入的内容（尾注不混进正文气泡）；
 * - 芯片按 Host 写下的 kind / label / source / detail 原样显示，不改写来源；
 * - 缺少尾注或格式无法解析时整条消息原样显示，绝不猜测哪些行是引用。
 *
 * 格式与 Host 一致，`historyReferences.parity.test.ts` 用 Host 的真实拼装结果
 * 互证，避免两边各写一份格式而悄悄漂移。
 */

export const PROMPT_CONTEXT_TITLE = /^—— PiDock 引用与附件（Host 附加，共 \d+ 项）——$/;
export const PROMPT_CONTEXT_NOTE = "以上是清单与来源身份，不是文件内容；需要时请用工具自行读取。";

export type HistoryReference = { kind: string; label: string; source?: string; detail?: string };

export type SplitPromptContext = { text: string; references: HistoryReference[] };

const ENTRY = /^- \[([a-z]+)\] (.+?)(?: — (.*))?$/;

function entryOf(line: string): HistoryReference | null {
  const match = ENTRY.exec(line);
  if (match === null) return null;
  const kind = match[1] ?? "";
  const label = match[2] ?? "";
  if (kind.length === 0 || label.length === 0) return null;
  const rest = match[3];
  if (rest === undefined) return { kind, label };
  // Host joins source and detail with ` · `; a missing half leaves one part.
  const parts = rest.split(" · ");
  if (parts.length === 1) return { kind, label, detail: parts[0]! };
  return { kind, label, source: parts[0]!, detail: parts.slice(1).join(" · ") };
}

/**
 * Split the Host's trailing identity block off one user message. The LAST
 * matching title line wins, so text the user typed that merely looks like a
 * title cannot make an earlier body line a reference.
 */
export function splitPromptContext(text: string): SplitPromptContext {
  const lines = text.split("\n");
  let titleIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (PROMPT_CONTEXT_TITLE.test(lines[index] ?? "")) { titleIndex = index; break; }
  }
  if (titleIndex === -1) return { text, references: [] };
  const references: HistoryReference[] = [];
  let index = titleIndex + 1;
  let sawNote = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === PROMPT_CONTEXT_NOTE) { sawNote = true; index += 1; break; }
    if (line === "引用" || line === "附件") continue;
    const entry = entryOf(line);
    if (entry === null) return { text, references: [] };
    references.push(entry);
  }
  // A block Host never closed is not a Host block: show the message unchanged.
  if (!sawNote || references.length === 0) return { text, references: [] };
  const prose = lines.slice(0, titleIndex).join("\n").replace(/\n+$/, "");
  return { text: prose, references };
}

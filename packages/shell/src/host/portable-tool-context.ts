import { createHash } from "node:crypto";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Tool } from "@earendil-works/pi-ai";

/** The SDK preserves domain tool names, while remote function identifiers forbid dots. */
export function portableToolContext(context: Context): { context: Context; restore: (event: AssistantMessageEvent) => AssistantMessageEvent } {
  const names = new Set<string>();
  const collect = (tools: { name: string }[] | undefined) => tools?.forEach(tool => names.add(tool.name));
  collect(context.tools);
  for (const message of context.messages) {
    if (message.role === "system") { collect(message.toolsAdded); collect(message.toolsRemoved); }
    if (message.role === "assistant") collect(message.content.filter(part => part.type === "toolCall"));
    if (message.role === "toolResult") names.add(message.toolName);
  }
  const aliases = new Map<string, string>();
  const originals = new Map<string, string>();
  for (const name of names) {
    const alias = /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name
      : `pidock_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
    if (originals.has(alias) && originals.get(alias) !== name) throw new Error("provider-tool-name-conflict");
    aliases.set(name, alias);
    originals.set(alias, name);
  }
  const wire = (name: string) => aliases.get(name) ?? name;
  const domain = (name: string) => originals.get(name) ?? name;
  const assistant = (message: AssistantMessage, rename: (name: string) => string): AssistantMessage => ({ ...message,
    content: message.content.map(part => part.type === "toolCall" ? { ...part, name: rename(part.name) } : part),
  });
  const tools = <T extends { name: string }>(rows: T[] | undefined): T[] | undefined => rows?.map(tool => ({ ...tool, name: wire(tool.name) }));
  const messages = context.messages.map((message): Message => {
    if (message.role === "system") return { ...message,
      ...(message.toolsAdded ? { toolsAdded: tools(message.toolsAdded) as Tool[] } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: tools(message.toolsRemoved)! } : {}),
    };
    if (message.role === "assistant") return assistant(message, wire);
    if (message.role === "toolResult") return { ...message, toolName: wire(message.toolName) };
    return message;
  });
  return {
    context: { ...context, ...(context.tools ? { tools: tools(context.tools) } : {}), messages },
    restore: event => {
      if (event.type === "done") return { ...event, message: assistant(event.message, domain) };
      if (event.type === "error") return { ...event, error: assistant(event.error, domain) };
      if (event.type === "toolcall_end") return { ...event, toolCall: { ...event.toolCall, name: domain(event.toolCall.name) }, partial: assistant(event.partial, domain) };
      return { ...event, partial: assistant(event.partial, domain) };
    },
  };
}

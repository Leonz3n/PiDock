import Markdown from "react-markdown";

/** Markdown stays text-only: raw HTML is never installed into the trusted renderer. */
export function ConversationMarkdown({ text }: { text: string }) {
  return <div className="conversation-markdown min-w-0 break-words [overflow-wrap:anywhere]">
    <Markdown components={{
      a: ({ children }) => <span>{children}</span>,
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
    }}>{text}</Markdown>
  </div>;
}

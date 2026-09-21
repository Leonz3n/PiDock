import { useEffect, useState } from "react";

type Highlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** Only the grammars this renderer actually shows are bundled. */
function loadHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
    ]).then(([core, engine, theme, bash, json, typescript, tsx]) =>
      core.createHighlighterCore({
        themes: [theme.default],
        langs: [bash.default, json.default, typescript.default, tsx.default],
        engine: engine.createJavaScriptRegexEngine(),
      }),
    );
  }
  return highlighterPromise as Promise<Highlighter>;
}

export function CodeBlock({ code, language, label }: { code: string; language: string; label?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadHighlighter()
      .then((highlighter) => highlighter.codeToHtml(code, { lang: language, theme: "github-light" }))
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <figure className="overflow-hidden rounded-md border border-line bg-soft/40" data-code-language={language}>
      {label ? <figcaption className="border-b border-line px-3 py-1.5 text-[11px] text-muted">{label}</figcaption> : null}
      {html ? (
        <div className="overflow-auto px-3 py-2 text-xs [&_pre]:!bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-auto px-3 py-2 text-xs text-ink">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  );
}

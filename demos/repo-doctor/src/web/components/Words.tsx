/** Copilot's words with their `inline code`, without a Markdown renderer. */
export function Words({ text }: { readonly text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`)/g).map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={index}>{part.replace(/\*\*/g, "")}</span>
        ),
      )}
    </>
  );
}

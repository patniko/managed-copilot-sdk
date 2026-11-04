/** Copilot's words with their `inline code` and [links](https://…), without a Markdown renderer. */
export function Words({ text }: { readonly text: string }) {
  return (
    <>
      {/* Link text and targets can't hold brackets or parentheses, so a line full of them is read once. */}
      {text.split(/(`[^`\n]+`|\[[^[\]\n]+\]\([^()\s]+\))/g).map((part, index) => {
        if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={index} className="inline-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        const link = /^\[([^[\]]+)\]\(([^()\s]+)\)$/.exec(part);
        if (link) {
          return /^https:\/\//.test(link[2]!) ? (
            <a key={index} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          ) : (
            <span key={index}>{link[1]}</span>
          );
        }
        return <span key={index}>{part.replace(/\*\*/g, "")}</span>;
      })}
    </>
  );
}

// Gwen writes Markdown. Telegram renders a small HTML subset and rejects a
// message whose markup it cannot parse, so replies are converted here and the
// adapter falls back to plain text if Telegram still refuses one.

/** Telegram's limit is 4096 characters after markup is parsed; leave headroom. */
export const CHUNK_CHARS = 3800;

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Markup outside code: headings, bullets, links, bold and italic. */
function inline(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => `<b>${title.replace(/\*\*/g, '')}</b>`)
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '%22')}">${label}</a>`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?;:]|$)/gm, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,!?;:]|$)/gm, '$1<i>$2</i>');
}

/** Convert Gwen's Markdown to the HTML Telegram accepts with parse_mode HTML. */
export function toTelegramHtml(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((block) => {
      const fence = /^```[^\n]*\n?([\s\S]*?)```$/.exec(block);
      if (fence) return `<pre>${escape(fence[1]!.replace(/\n$/, ''))}</pre>`;
      return block
        .split(/(`[^`\n]+`)/g)
        .map((part) =>
          /^`[^`\n]+`$/.test(part) ? `<code>${escape(part.slice(1, -1))}</code>` : inline(escape(part)),
        )
        .join('');
    })
    .join('');
}

/**
 * Split a long reply into messages Telegram will take, breaking at a blank
 * line where there is one, else at a line end, else mid-line.
 */
export function chunks(text: string, limit = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const paragraph = window.lastIndexOf('\n\n');
    const line = window.lastIndexOf('\n');
    const cut = paragraph > limit / 2 ? paragraph : line > limit / 2 ? line : limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

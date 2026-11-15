import type { Connections, Quote } from '@/types';

/** Links are stored the way the vault writes them: `[[brackets included]]`. */
const asLink = (link: string) => `[[${link.trim()}]]`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Attach a passage to a piece. It rides with the connections, and the note
 * it comes from joins the links (`sparked-by` / `riffs-on`) unless it is
 * already there. A passage with no link adds none. Any passage attached
 * before is replaced.
 */
export function attachQuote(conn: Connections, quote: Quote): Connections {
  const base = detachQuote(conn);
  const link = quote.link.trim() ? asLink(quote.link) : '';
  const links = link && !base.links.some(l => same(l, link)) ? [...base.links, link] : base.links;
  return { ...base, links, quote };
}

/** Take the passage off again, along with the link it brought. */
export function detachQuote(conn: Connections): Connections {
  if (!conn.quote) return conn;
  const link = conn.quote.link.trim() ? asLink(conn.quote.link) : '';
  return { ...conn, quote: null, links: link ? conn.links.filter(l => !same(l, link)) : conn.links };
}

/** "Martin Buber, I and Thou, p. 11", leaving out whatever is missing. */
export function quoteAttribution(quote: Quote): string {
  return [quote.author.trim(), quote.title.trim(), quote.page.trim() && `p. ${quote.page.trim()}`].filter(Boolean).join(', ');
}

/** The passage's paragraphs: split wherever there is a blank line. */
export function quoteParagraphs(quote: Quote): string[] {
  return quote.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

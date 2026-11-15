import type { Quote } from '@/types';
import { quoteAttribution, quoteParagraphs } from '@/utils/quote';
import Icon from './Icon';

/**
 * The passage this piece responds to, handed over by another app (Trove).
 * Read-only: it is shown beside the writing, never inside it, and joins the
 * note as a blockquote only when the piece is sent. The small × takes it
 * off again.
 */
export default function AttachedQuote({ quote, onRemove }: { quote: Quote; onRemove: () => void }) {
  const attribution = quoteAttribution(quote);
  return <figure className="attached-quote" aria-label="Quoted passage">
    <blockquote>{quoteParagraphs(quote).map((paragraph, i) => <p key={i}>{paragraph}</p>)}</blockquote>
    {attribution && <figcaption>— {attribution}</figcaption>}
    <button className="attached-quote-remove" aria-label="Remove the quote" title="Remove the quote" onClick={onRemove}><Icon name="close" size={11}/></button>
  </figure>;
}

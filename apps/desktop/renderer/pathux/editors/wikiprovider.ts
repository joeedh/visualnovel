import { MarkdownProvider, type MarkdownProviderOptions } from 'pathux-richtext-markdown';
import SHEETFORM_CSS from '../../styles/sheetform.css?inline';

/**
 * The Wiki pane's markdown provider: path.ux's, with the app's rules for the front-matter form
 * appended to the stylesheet the editor puts in its shadow root. One is built per document
 * session, so `path` is the document's own and stays right in a second pane on the same session.
 */
export class WikiProvider extends MarkdownProvider {
  constructor(
    readonly path: string,
    options: MarkdownProviderOptions = {},
  ) {
    super(options);
  }

  override styles(): string {
    return super.styles() + SHEETFORM_CSS;
  }
}

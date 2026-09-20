import { MarkdownProvider, type MarkdownProviderOptions } from 'pathux-richtext-markdown';
import ASSETSTRIP_CSS from '../../styles/assetstrip.css?inline';
import RUNG_CSS from '../../styles/rung.css?inline';
import SHEETFORM_CSS from '../../styles/sheetform.css?inline';

/**
 * The Wiki pane's markdown provider: path.ux's, with the app's rules for the front-matter form
 * appended to the stylesheet the editor puts in its shadow root. One is built per document
 * session, so `path` is the document's own and stays right in a second pane on the same session.
 *
 * The strip's cells and the rung's boxes come along because the wardrobe draws both inside the
 * form, where the pane's own adopted sheets do not reach.
 */
export class WikiProvider extends MarkdownProvider {
  constructor(
    readonly path: string,
    options: MarkdownProviderOptions = {},
  ) {
    super(options);
  }

  override styles(): string {
    return super.styles() + ASSETSTRIP_CSS + RUNG_CSS + SHEETFORM_CSS;
  }
}

import { ThumbnailCache, pickAssetPopup, type RowFrame } from 'pathux';
import {
  MarkdownProvider,
  addSeparator,
  addToolButton,
  markdownOps,
  type MarkdownProviderOptions,
  type MdDoc,
  type ToolButton,
} from 'pathux-richtext-markdown';
import type { DocRange, ProviderContext, ToolbarSync } from 'pathux-richtext-headless';
import { exec, report, say } from '../app/bridge.js';
import { assetThumbUrl, galleryItem } from '../assets/assetthumb.js';
import { pictureAsset, pictureSrc } from '../assets/picturepath.js';
import { PICTURE_TIP } from '../../rules/wiki.js';
import ASSETSTRIP_CSS from '../../styles/assetstrip.css?inline';
import RUNG_CSS from '../../styles/rung.css?inline';
import SHEETFORM_CSS from '../../styles/sheetform.css?inline';
import type { AssetListing } from '../../../src/shared/ipc.js';

/** Marks the toolbar's picture button, which the Wiki pane records on its own anchor pass. */
export const PICTURE_BUTTON = 'wiki-picture';

/** Said when the caret is nowhere a picture can go: not in the text, or in a fence or a table. */
const NO_CARET = 'Place the cursor in a paragraph where the picture should go first.';

/**
 * The Wiki pane's markdown provider: path.ux's, with the app's rules for the front-matter form
 * appended to the stylesheet the editor puts in its shadow root, a picture mapped from the path
 * written in the prose to the url the app loads it from, and a toolbar button that inserts one.
 * One is built per document session, so `path` is the document's own and stays right in a second
 * pane on the same session; what a button needs of its own pane it reads from the editor bridge.
 *
 * The strip's cells and the rung's boxes come along because the wardrobe draws both inside the
 * form, where the pane's own adopted sheets do not reach.
 */
export class WikiProvider extends MarkdownProvider {
  /** Decoded thumbnails, kept with the session so a reopened picker redraws from them. */
  private readonly thumbs = new ThumbnailCache();

  constructor(
    readonly path: string,
    options: MarkdownProviderOptions = {},
  ) {
    super({
      resolveSrc: (src) => {
        const picture = pictureAsset(path, src);
        return picture && assetThumbUrl(picture.hash, picture.ext);
      },
      ...options,
    });
  }

  override styles(): string {
    return super.styles() + ASSETSTRIP_CSS + RUNG_CSS + SHEETFORM_CSS;
  }

  /**
   * The inherited row, then Insert a picture. The button reads the selection when pressed and
   * the document from the sync, the way the Link button does, because one provider builds a
   * toolbar per editor and the closure is the only per-editor state there is.
   */
  override buildToolbar(row: RowFrame<ProviderContext>, ctx: ProviderContext): ToolbarSync<MdDoc> {
    const sync = super.buildToolbar(row, ctx);
    let doc: MdDoc | undefined;
    let selection: DocRange | undefined;
    addSeparator(row);
    const button = addToolButton(row, '&#9635;', PICTURE_TIP, () => {
      const at = ctx.editor.selection() ?? selection;
      if (doc && at) void this.insertPicture(button, ctx, doc, at);
      else say(NO_CARET, true);
    });
    button.setAttribute('data-testid', PICTURE_BUTTON);
    return (next, range) => {
      doc = next;
      selection = range;
      sync(next, range);
    };
  }

  /**
   * Pick a picture from the manifest and put it where the caret is, as an image atom whose `src`
   * is the document-relative path to the stored file and whose `alt` is the picture's label. The
   * manifest is read when the popup opens rather than followed, since the choice is over what
   * exists at that moment.
   */
  private async insertPicture(
    button: ToolButton,
    ctx: ProviderContext,
    doc: MdDoc,
    at: DocRange,
  ): Promise<void> {
    const block = doc.blocks.find((b) => b.id === at.head.block);
    if (!block || this.isOpaque(doc, block.id) || block.kind === 'code') return say(NO_CARET, true);

    const outcome = await exec('asset.list', {});
    if (!outcome.ok) return report(outcome);
    const assets = outcome.data as AssetListing[] | undefined;
    if (!assets?.length) return say('This project has no pictures to insert yet.', true);

    const rect = button.getBoundingClientRect();
    const picked = await pickAssetPopup(button, {
      items: assets.map(galleryItem),
      cache: this.thumbs,
      at   : { x: rect.left, y: rect.bottom },
    });
    const asset = picked && assets.find((a) => a.hash === picked.id);
    if (!asset) return;

    await ctx.editor.dispatch(
      markdownOps.insertImage(block.id, at.head.offset, {
        src: pictureSrc(this.path, asset.file),
        alt: asset.label,
      }),
    );
  }
}

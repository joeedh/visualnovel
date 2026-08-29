/**
 * The one command over the story bible, read-only and budgeted. There is no `bible.read` because
 * `@vn/bible` has no whole-file API — a surface that wants the bible gets ranked excerpts or
 * opens the file itself.
 */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const bibleSearch = define({
  id: 'bible.search',
  title: 'Search the story bible',
  description: 'Rank passages in wiki/ against a query; returns file:line excerpts, not files.',
  notes:
    'Ranked excerpts from `wiki/`. There is no `bible.read`: [`@vn/bible`](story-bible.md) has no whole-file API.',
  mutating: false,
  props: {
    query: prop.string('what to look for, in words'),
    limit: prop.number('most excerpts to return', { default: 8, min: 1, max: 50 }),
  },
  async run(props, ctx) {
    const excerpts = await ctx.host.session.searchBible(props.query, props.limit);
    const where = excerpts.length === 0 ? 'Nothing in the bible' : `${excerpts.length} passage(s)`;
    return { message: `${where} for "${props.query}".`, data: excerpts };
  },
});

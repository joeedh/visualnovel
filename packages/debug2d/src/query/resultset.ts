/**
 * The chainable result set. Ordering is part of the contract (research §5): every set is
 * sorted by z descending, then FragId, so golden tests and future invariants can assert
 * on the order.
 */
import { fmtNum, fmtRect, padCols } from '../explain/format.js';
import type { Fragment, Frame, OwnerRef, SourceId } from '../types.js';

export type TableRow = {
  id: string;
  owner: string;
  source: SourceId;
  kind: Fragment['kind'];
  bounds: string;
  tags: string[];
  z: number;
};

const byStack = (a: Fragment, b: Fragment) => b.z - a.z || a.id.localeCompare(b.id);

export class ResultSet {
  readonly frame: Frame;
  /** Sorted top-first: z descending, then FragId. */
  readonly fragments: readonly Fragment[];
  /** Sources present in the frame that could not answer this query, listed here rather
   * than counted as zero hits. */
  readonly unsupported: readonly SourceId[];
  /** The query description, e.g. `at(412, 88) css` — the explain() header. */
  readonly desc: string;

  constructor(frame: Frame, fragments: Fragment[], desc: string, unsupported: SourceId[] = []) {
    this.frame = frame;
    this.fragments = [...fragments].sort(byStack);
    this.desc = desc;
    this.unsupported = unsupported;
  }

  get length(): number {
    return this.fragments.length;
  }

  first(): Fragment | undefined {
    return this.fragments[0];
  }

  isEmpty(): boolean {
    return this.fragments.length === 0;
  }

  private chain(fragments: Fragment[], step: string): ResultSet {
    return new ResultSet(this.frame, fragments, `${this.desc}${step}`, [...this.unsupported]);
  }

  where(pred: (f: Fragment) => boolean): ResultSet {
    return this.chain(this.fragments.filter(pred), '.where(…)');
  }

  byTag(tag: string): ResultSet {
    return this.chain(
      this.fragments.filter((f) => f.tags.includes(tag)),
      `.byTag('${tag}')`,
    );
  }

  bySource(id: SourceId): ResultSet {
    return this.chain(
      this.fragments.filter((f) => f.source === id),
      `.bySource('${id}')`,
    );
  }

  byOwner(id: string): ResultSet {
    return this.chain(
      this.fragments.filter((f) => f.owner.id === id),
      `.byOwner('${id}')`,
    );
  }

  /**
   * Expand to every frame fragment whose owner-ancestry (OwnerRef.parent links) reaches
   * an owner in this set — `byOwner('Floor').descendants()` is the whole widget subtree.
   */
  descendants(): ResultSet {
    const roots = new Set(this.fragments.map((f) => f.owner.id));
    const parentOf = new Map<string, string | undefined>();
    for (const f of this.frame.fragments) parentOf.set(f.owner.id, f.owner.parent);
    const inSubtree = (start: string): boolean => {
      const seen = new Set<string>();
      for (let id: string | undefined = start; id !== undefined && !seen.has(id);) {
        if (roots.has(id)) return true;
        seen.add(id);
        id = parentOf.get(id);
      }
      return false;
    };
    return this.chain(
      this.frame.fragments.filter((f) => inSubtree(f.owner.id)),
      '.descendants()',
    );
  }

  /** Collapse fragments → owning nodes, top-of-stack first. */
  owners(): { owner: OwnerRef; fragments: number }[] {
    const seen = new Map<string, { owner: OwnerRef; fragments: number }>();
    for (const f of this.fragments) {
      const entry = seen.get(f.owner.id);
      if (entry) entry.fragments++;
      else seen.set(f.owner.id, { owner: f.owner, fragments: 1 });
    }
    return [...seen.values()];
  }

  /** Plain data — owner, source, bounds, tags, z. JSON-safe, crosses CDP. */
  table(): TableRow[] {
    return this.fragments.map((f) => ({
      id    : f.id,
      owner : f.owner.id,
      source: f.source,
      kind  : f.kind,
      bounds: fmtRect(f.bounds),
      tags  : f.tags,
      z     : f.z,
    }));
  }

  /** The compact ASCII stack (research §9). Deterministic and diffable — golden-safe. */
  explain(): string {
    const header = `${this.desc} → ${this.length} fragment${this.length === 1 ? '' : 's'}, top-first`;
    const rows = this.fragments.map((f) => {
      const flags: string[] = [];
      if (f.style.alpha < 1) flags.push(`α${fmtNum(f.style.alpha)}`);
      if (f.pick.mode === 'none') flags.push('pick=none');
      return [
        f.source,
        `#${f.id}`,
        f.kind,
        f.owner.label,
        fmtRect(f.bounds),
        `z=${f.z}`,
        flags.join(' '),
      ];
    });
    const lines = [header, ...padCols(rows).map((r) => `  ${r}`)];
    for (const s of this.unsupported) lines.push(`  ⚠ source '${s}' could not answer this query`);
    return lines.join('\n');
  }
}

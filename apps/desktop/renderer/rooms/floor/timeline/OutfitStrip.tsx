import { INHERIT, shadowedMarker, sourceLabel, type OutfitRow } from './wardrobe.js';

/**
 * The wardrobe below the strip: what the scene puts each character in, and what the selected shot
 * overrides. Two levels, one list, because an author asking "why is she in the uniform" is asking
 * about both at once — every row names the level that answered rather than saying "inherited".
 *
 * A select rather than a drag: this is a choice from a fixed set, not a gesture over the script,
 * and the set is the wardrobe the command would accept. Which rows exist is `wardrobe.ts`.
 */
export function OutfitStrip(props: {
  rows: OutfitRow[];
  shot: string | null;
  onSet: (row: OutfitRow, outfit: string) => void;
}): JSX.Element | null {
  if (props.rows.length === 0) return null;
  const scene = props.rows.filter((r) => r.level === 'scene');
  const shot = props.rows.filter((r) => r.level === 'shot');

  return (
    <div className="tl-wardrobe">
      <Section title="WEARING" note="for the whole scene" rows={scene} onSet={props.onSet} />
      {props.shot && (
        <Section
          title="IN THIS SHOT"
          note={shot.length ? props.shot : `${props.shot} frames nobody`}
          rows={shot}
          onSet={props.onSet}
        />
      )}
    </div>
  );
}

function Section(props: {
  title: string;
  note: string;
  rows: OutfitRow[];
  onSet: (row: OutfitRow, outfit: string) => void;
}): JSX.Element {
  return (
    <div className="wd-section">
      <div className="wd-head">
        <span className="tt">{props.title}</span>
        <span className="ct">{props.note}</span>
      </div>
      {props.rows.map((row) => (
        <Row key={`${row.level}:${row.character}`} row={row} onSet={props.onSet} />
      ))}
    </div>
  );
}

function Row(props: {
  row: OutfitRow;
  onSet: (row: OutfitRow, outfit: string) => void;
}): JSX.Element {
  const { row } = props;
  const shadowed = shadowedMarker(row);
  return (
    <div className="wd-row">
      <span className="who">{row.character}</span>
      <select
        className="wd-pick"
        value={row.value}
        aria-label={`What ${row.character} wears ${row.level === 'scene' ? 'in the scene' : 'in this shot'}`}
        onChange={(e) => props.onSet(row, e.target.value)}
      >
        {/* The fallback is named in the option itself: "inherit" alone makes the author open the
            other level to find out what they would be inheriting. */}
        <option value={INHERIT}>inherit — {sourceLabel(row.inherits)}</option>
        {row.outfits.map((outfit) => (
          <option key={outfit} value={outfit}>
            {outfit}
          </option>
        ))}
      </select>
      {shadowed ? (
        <span className="wd-shadow">
          hides the scene&rsquo;s &ldquo;{shadowed}&rdquo; — clear it to let the marker through
        </span>
      ) : (
        <span className="wd-from">{sourceLabel(row.effective)}</span>
      )}
    </div>
  );
}

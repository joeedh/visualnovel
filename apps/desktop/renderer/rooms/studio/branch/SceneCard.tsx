import type { StoryScene } from '../../../../src/shared/ipc';

/**
 * One scene as an index card — the writers'-room artifact this whole surface is imitating.
 * The id is machine-side (`--mono`), the synopsis is authored (`--prose`), and the cast is the
 * one line that says who is in it without opening the scene.
 */
export function SceneCard(props: {
  scene: StoryScene;
  entry: boolean;
  selected: boolean;
  ghost?: boolean;
}): JSX.Element {
  const { scene } = props;
  const classes = [
    'scene-card',
    scene.reachable ? '' : 'dead',
    props.entry ? 'entry' : '',
    props.selected ? 'sel' : '',
    props.ghost ? 'carried' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article className={classes} title={scene.reachable ? scene.id : `${scene.id} — unreachable`}>
      <header>
        <span className="id">{scene.id}</span>
        <span className="loc">{scene.location}</span>
      </header>
      <p className="synopsis">{scene.synopsis ?? <span className="unwritten">no synopsis</span>}</p>
      <footer>
        <span className="cast">{scene.characters.join(' · ') || '—'}</span>
        <span className="lines">{scene.lines}L</span>
      </footer>
      <span className="handle" aria-hidden="true" />
    </article>
  );
}

/** The stand-in for a `goto` with no scene behind it. Never a drop target — there is no scene. */
export function StubCard(props: { id: string }): JSX.Element {
  return (
    <div className="scene-stub" title={`${props.id} — no scene by that name`}>
      <span className="id">{props.id}</span>
      <span className="tag">unwritten</span>
    </div>
  );
}

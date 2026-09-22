/**
 * The check a merged file passes before it is written over a conflict: the one the History pane's
 * Save and the agent's `resolve_conflict` share, so both refuse the same text with the same
 * sentence. It classifies the path itself, since the hosts' file kinds live in neither package.
 */
import { parseFrontMatter, splitFrontMatter, yamlProblem } from '@vn/parse';
import { hasConflictMarkers } from '@vn/util/conflict';
import { characterFromDoc, locationFromDoc, sceneFromDoc, sceneTextProblem } from './entities.js';

const SCENE = /^scenes\/([^/]+)\.md$/;
const CHARACTER = /^characters\/[^/]+\/character\.md$/;
const LOCATION = /^locations\/[^/]+\.md$/;

/**
 * Why `text` would not load as `scenes/<id>.md`, or undefined when it would, counting an
 * error-severity diagnostic as a failure. `sceneTextProblem` stops at "loads"; a scene that marks
 * one line id twice loads and is still refused by every prose op, so a whole-file write asks this.
 */
export function sceneLoadProblem(id: string, text: string): string | undefined {
  const problem = sceneTextProblem(id, text);
  if (problem !== undefined) return problem;
  const read = sceneFromDoc(parseFrontMatter(text), id);
  if (!read.ok) return read.diagnostic.message;
  const errors = read.value.diagnostics.filter((d) => d.severity === 'error');
  return errors.length > 0 ? errors.map((d) => d.message).join(' ') : undefined;
}

/**
 * Why `text` may not be written as `path` to decide a conflict, or undefined when it may. A scene
 * must load cleanly, a sheet must pass its schema, JSON and YAML must parse, and any other
 * markdown needs front matter that parses; anything else is taken as it is. Markers left in prose
 * are not refused here, since an author may save part way and Continue checks again; markers in
 * data are, since YAML reads a marker line as a scalar and would keep it.
 */
export function resolutionProblem(path: string, text: string): string | undefined {
  const scene = SCENE.exec(path);
  if (scene) {
    const problem = sceneLoadProblem(scene[1]!, text);
    return problem === undefined ? undefined : `${path} would not load: ${problem}`;
  }
  const data = /\.(json|ya?ml)$/.test(path) || CHARACTER.test(path) || LOCATION.test(path);
  if (hasConflictMarkers(data ? text : splitFrontMatter(text).prefix)) {
    return `${path} still holds conflict markers${data ? '' : ' in its front matter'}.`;
  }
  if (path.endsWith('.json')) {
    try {
      JSON.parse(text);
      return undefined;
    } catch (err) {
      return `${path} is not valid JSON: ${(err as Error).message}`;
    }
  }
  if (/\.ya?ml$/.test(path)) {
    const problem = yamlProblem(text);
    return problem === undefined ? undefined : `${path} is not valid YAML: ${problem}`;
  }
  if (!path.endsWith('.md')) return undefined;
  let doc;
  try {
    doc = parseFrontMatter(text);
  } catch (err) {
    return `${path}'s front matter will not parse: ${(err as Error).message.split('\n')[0]}`;
  }
  if (CHARACTER.test(path)) {
    const read = characterFromDoc(doc);
    return read.ok ? undefined : `${path} would not load: ${read.diagnostic.message}`;
  }
  if (LOCATION.test(path)) {
    const read = locationFromDoc(doc);
    return read.ok ? undefined : `${path} would not load: ${read.diagnostic.message}`;
  }
  return undefined;
}

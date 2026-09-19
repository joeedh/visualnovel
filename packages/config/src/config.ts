import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { projectConfig, type Lettering, type ProjectConfig } from '@vn/types';
import { ConfigError, exists, readText, writeFileAtomic } from '@vn/util';

export type { ProjectConfig };

/** Default name of the project config file at the project root. */
export const CONFIG_FILENAME = 'project.yaml';

/** Load and validate `project.yaml` from a project directory (report §8, §11). */
export async function loadConfig(projectDir: string): Promise<ProjectConfig> {
  const path = join(projectDir, CONFIG_FILENAME);
  if (!(await exists(path))) {
    throw new ConfigError(`no ${CONFIG_FILENAME} found in ${projectDir}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(await readText(path));
  } catch (err) {
    throw new ConfigError(`failed to parse ${CONFIG_FILENAME}`, { cause: err });
  }
  const result = projectConfig.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid ${CONFIG_FILENAME}: ${issues}`);
  }
  return result.data;
}

/** A top-level `start:` line, with whatever terminated it. */
const START_LINE = /^start:[^\r\n]*(\r?\n|$)/m;
const TITLE_LINE = /^title:[^\r\n]*(?:\r?\n|$)/m;

/**
 * Replace or add `start:` in `project.yaml` text, leaving every other byte alone. A project
 * config is hand-written and commented, so it is spliced rather than re-serialized — the same
 * reason the prose writers splice front-matter. The value goes through the YAML serializer, so
 * an id that YAML would otherwise read as a bool or a number comes back quoted.
 */
export function withStartScene(text: string, sceneId: string): string {
  const line = stringifyYaml({ start: sceneId });
  if (START_LINE.test(text)) {
    return text.replace(START_LINE, (_m, nl: string) => (nl ? line : line.trimEnd()));
  }
  // Add the line next to the title if there is one; a config with neither key is presumably
  // nearly empty.
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return text.slice(0, at) + line + text.slice(at);
  }
  return text === '' || text.endsWith('\n') ? text + line : `${text}\n${line}`;
}

/**
 * The top-level `project.yaml` keys a command may write one at a time, each a scalar the
 * splice below can replace. `start` has its own splice in {@link withStartScene}.
 */
export type ConfigTextKey = 'art_style' | 'storyboard_notes' | 'lettering';

/** Split `text` into lines that keep their own terminators, so a splice can be byte-exact. */
function keepLines(text: string): string[] {
  return text.split(/(?<=\n)/);
}

/**
 * Replace or add one top-level key in `project.yaml` text, leaving every other byte alone — the
 * same splice {@link withStartScene} performs, and for the same reason.
 *
 * Unlike `start:`, the value may be prose already written as a block scalar, so the entry it
 * replaces is the header line plus the indented lines under it. The replacement goes through the
 * YAML serializer, which picks the quoting or block form the value needs.
 */
export function withConfigKey(text: string, key: ConfigTextKey, value: string): string {
  const entry = stringifyYaml({ [key]: value });
  const found = new RegExp(`^${key}:`, 'm').exec(text);
  if (found) {
    const lines = keepLines(text.slice(found.index));
    let end = found.index + (lines[0]?.length ?? 0);
    // A blank line only belongs to the entry if indented text follows it — otherwise it is the
    // author's spacing before the next key, and swallowing it would reflow their file.
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^[ \t]/.test(line)) {
        end += line.length;
        continue;
      }
      if (!line.trim() && lines.slice(i + 1).some((l) => /^[ \t]/.test(l))) {
        end += line.length;
        continue;
      }
      break;
    }
    // The serialized entry always ends in a newline; the entry it replaces only does if the file
    // did, so an unterminated last line stays unterminated.
    const terminated = text.slice(found.index, end).endsWith('\n');
    return text.slice(0, found.index) + (terminated ? entry : entry.trimEnd()) + text.slice(end);
  }
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return text.slice(0, at) + entry + text.slice(at);
  }
  return text === '' || text.endsWith('\n') ? text + entry : `${text}\n${entry}`;
}

/** {@link withConfigKey} for `art_style`. */
export function withArtStyle(text: string, style: string): string {
  return withConfigKey(text, 'art_style', style);
}

/** A top-level `models:` line, with whatever terminated it. */
const MODELS_LINE = /^models:[^\r\n]*(?:\r?\n|$)/m;
/** An indented `image:` line inside a block, with whatever terminated it. */
const IMAGE_LINE = /^([ \t]+)image:[^\r\n]*(?:\r?\n|$)/m;
/** What a `models:` block's rows are indented by when the block has no rows to copy from. */
const BLOCK_INDENT = '  ';

/**
 * Replace or add `models.image` in `project.yaml` text, leaving every other byte alone. The key
 * is nested, so the splice works inside the `models:` block: an `image:` row there is replaced
 * at its own indent, a block without one gets the row as its first line, and a file with no
 * `models:` block gets the block after `title:` the way {@link withConfigKey} places a key. The
 * value goes through the YAML serializer, so an id YAML would read as something else comes back
 * quoted.
 */
export function withImageModel(text: string, modelId: string): string {
  const row = (indent: string): string => `${indent}${stringifyYaml({ image: modelId })}`;
  const header = MODELS_LINE.exec(text);
  if (header) {
    const start = header.index + header[0].length;
    const lines = keepLines(text.slice(start));
    let end = start;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const blankBeforeRow = !line.trim() && lines.slice(i + 1).some((l) => /^[ \t]/.test(l));
      if (!/^[ \t]/.test(line) && !blankBeforeRow) break;
      end += line.length;
    }

    const block = text.slice(start, end);
    const found = IMAGE_LINE.exec(block);
    if (found) {
      const terminated = found[0].endsWith('\n');
      const replaced = terminated ? row(found[1]!) : row(found[1]!).trimEnd();
      return (
        text.slice(0, start + found.index) +
        replaced +
        text.slice(start + found.index + found[0].length)
      );
    }

    const first = /^([ \t]+)\S/m.exec(block);
    const headerEnded = header[0].endsWith('\n');
    const inserted = row(first?.[1] ?? BLOCK_INDENT);
    return headerEnded
      ? text.slice(0, start) + inserted + text.slice(start)
      : `${text.slice(0, start)}\n${inserted.trimEnd()}${text.slice(start)}`;
  }

  const entry = `models:\n${row(BLOCK_INDENT)}`;
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return text.slice(0, at) + entry + text.slice(at);
  }
  return text === '' || text.endsWith('\n') ? text + entry : `${text}\n${entry}`;
}

/** A top-level `builtin_skills:` line, with whatever terminated it. */
const BUILTIN_SKILLS_LINE = /^builtin_skills:[^\r\n]*(?:\r?\n|$)/m;

/**
 * Replace or add `builtin_skills` in `project.yaml` text, leaving every other byte alone. The
 * value is a list, so the entry it replaces is the header line plus the rows under it — and YAML
 * lets a list's rows sit at the header's own column (`- id` with no indent), so a row is any
 * line that is indented or begins with `-`, not only an indented one the way {@link withConfigKey}
 * counts. An empty list is written in flow form (`builtin_skills: []`), which is what the
 * serializer emits for it and what reads back as "none enabled" rather than as the default.
 */
export function withBuiltinSkills(text: string, ids: readonly string[]): string {
  const entry = stringifyYaml({ builtin_skills: [...ids] });
  const header = BUILTIN_SKILLS_LINE.exec(text);
  if (header) {
    const start = header.index + header[0].length;
    const lines = keepLines(text.slice(start));
    let end = start;
    const isRow = (line: string): boolean => /^[ \t]/.test(line) || /^-(?:\s|$)/.test(line);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const blankBeforeRow = !line.trim() && lines.slice(i + 1).some(isRow);
      if (!isRow(line) && !blankBeforeRow) break;
      end += line.length;
    }
    // The serialized entry always ends in a newline; the entry it replaces only does if the file
    // did, so an unterminated last line stays unterminated.
    const terminated = text.slice(header.index, end).endsWith('\n');
    return text.slice(0, header.index) + (terminated ? entry : entry.trimEnd()) + text.slice(end);
  }
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return text.slice(0, at) + entry + text.slice(at);
  }
  return text === '' || text.endsWith('\n') ? text + entry : `${text}\n${entry}`;
}

/**
 * Write which builtin skills a project enables. Returns false when the file already lists exactly
 * those ids in that order. The result is re-parsed and read back before it is written, so a
 * splice the schema would refuse never lands. Ids are written as given: filtering them against
 * the catalog is the reader's job (`@vn/authoring`'s skill roots), which is also what lets a
 * project keep naming a skill a later app no longer ships.
 */
export async function setBuiltinSkills(
  projectDir: string,
  ids: readonly string[],
): Promise<boolean> {
  const path = join(projectDir, CONFIG_FILENAME);
  const before = await readText(path);
  const after = withBuiltinSkills(before, ids);
  if (after === before) return false;

  let raw: unknown;
  try {
    raw = parseYaml(after);
  } catch {
    raw = undefined;
  }
  const parsed = projectConfig.safeParse(raw ?? {});
  const same =
    parsed.success &&
    parsed.data.builtin_skills.length === ids.length &&
    parsed.data.builtin_skills.every((id, i) => id === ids[i]);
  if (!same) {
    throw new ConfigError(`could not set builtin_skills in ${path}; set it by hand`);
  }
  await writeFileAtomic(path, after);
  return true;
}

/**
 * Set one top-level key of a project's config. Returns false when it already said that — a
 * committed config that would not change must not be rewritten. The result is re-parsed before
 * it is written, so a value the schema refuses (a lettering mode it does not know) never lands.
 */
async function setConfigKey(
  projectDir: string,
  key: ConfigTextKey,
  value: string,
): Promise<boolean> {
  const path = join(projectDir, CONFIG_FILENAME);
  const before = await readText(path);
  const after = withConfigKey(before, key, value);
  if (after === before) return false;

  const parsed = projectConfig.safeParse(parseYaml(after) ?? {});
  if (!parsed.success || parsed.data[key] !== value) {
    throw new ConfigError(`could not set ${key} in ${path}; set it by hand`);
  }
  await writeFileAtomic(path, after);
  return true;
}

/** Set a project's art style. */
export function setArtStyle(projectDir: string, style: string): Promise<boolean> {
  return setConfigKey(projectDir, 'art_style', style);
}

/** Set the directives the decomposer is given beside the art style. */
export function setStoryboardNotes(projectDir: string, notes: string): Promise<boolean> {
  return setConfigKey(projectDir, 'storyboard_notes', notes);
}

/** Set who letters a page shot. Refuses a mode the schema does not know. */
export function setLettering(projectDir: string, lettering: Lettering): Promise<boolean> {
  return setConfigKey(projectDir, 'lettering', lettering);
}

/**
 * Set a project's image model, `models.image`. Returns false when it already said that. The
 * result is re-parsed and read back through the nested path before it is written, so a `models:`
 * block the splice could not place a row in never lands.
 */
export async function setImageModel(projectDir: string, modelId: string): Promise<boolean> {
  const path = join(projectDir, CONFIG_FILENAME);
  const before = await readText(path);
  const after = withImageModel(before, modelId);
  if (after === before) return false;

  // A row spliced into a block written in flow form (`models: {}`) is not YAML at all, so the
  // parse itself can throw here, and that is the same refusal as a value the schema rejects
  let raw: unknown;
  try {
    raw = parseYaml(after);
  } catch {
    raw = undefined;
  }
  const parsed = projectConfig.safeParse(raw ?? {});
  if (!parsed.success || parsed.data.models.image !== modelId) {
    throw new ConfigError(`could not set models.image in ${path}; set it by hand`);
  }
  await writeFileAtomic(path, after);
  return true;
}

/**
 * Point a project's `start:` at a scene. Returns false when it already named that scene — a
 * committed config that would not change must not be rewritten.
 */
export async function setStartScene(projectDir: string, sceneId: string): Promise<boolean> {
  const path = join(projectDir, CONFIG_FILENAME);
  const before = await readText(path);
  const after = withStartScene(before, sceneId);
  if (after === before) return false;

  // The splice is textual, so prove the result still parses and says what it was meant to say
  // before it replaces a file the author wrote.
  const parsed = projectConfig.safeParse(parseYaml(after) ?? {});
  if (!parsed.success || parsed.data.start !== sceneId) {
    throw new ConfigError(`could not set start: ${sceneId} in ${path}; set it by hand`);
  }
  await writeFileAtomic(path, after);
  return true;
}

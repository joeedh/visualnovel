import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { projectConfig, type ProjectConfig } from '@vn/types';
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
 * an id YAML would otherwise read as a bool or a number comes back quoted.
 */
export function withStartScene(text: string, sceneId: string): string {
  const line = stringifyYaml({ start: sceneId });
  if (START_LINE.test(text)) {
    return text.replace(START_LINE, (_m, nl: string) => (nl ? line : line.trimEnd()));
  }
  // Next to the title if there is one; a config with neither key is presumably nearly empty.
  const title = TITLE_LINE.exec(text);
  if (title) {
    const at = title.index + title[0].length;
    return text.slice(0, at) + line + text.slice(at);
  }
  return text === '' || text.endsWith('\n') ? text + line : `${text}\n${line}`;
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

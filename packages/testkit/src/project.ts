import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ProjectModel, Providers } from '@vn/types';
import { writeFileAtomic } from '@vn/util';
import type { ProjectConfig } from '@vn/config';
import { loadConfig } from '@vn/config';
import { parseFountain } from '@vn/parse';
import { modelFromInputs, slug, splitScenes } from '@vn/model';
import {
  AssetStore,
  ProjectPaths,
  loadInputs,
  setCharacterApproval,
  writeApprovedPortrait,
} from '@vn/store';
import { Git, openGit } from '@vn/git';
import { TaskGraph, loadGraph } from '@vn/taskgraph';
import {
  AssetCache,
  CachedImageBackend,
  StubImageBackend,
  createMockProviders,
  type ImageBackend,
} from '@vn/providers';
import { runPipeline, type RunSummary } from '@vn/scheduler';
import {
  characterDoc,
  locationDoc,
  projectYaml,
  titleCase,
  toSpec,
  type CharacterSpec,
  type LocationSpec,
} from './inputs.js';
import { SCRIPTS } from './scripts.js';
import { FIXTURE_ASSET_DIR } from './assets.js';

/** Everything `reload()` re-reads from disk — the same bundle `apps/cli` assembles. */
export interface ProjectState {
  config: ProjectConfig;
  model: ProjectModel;
  store: AssetStore;
  graph: TaskGraph;
}

/** How a run should behave. Mock providers unless told otherwise; `dryRun` plans and previews only. */
export interface RunOptions {
  dryRun?: boolean;
  /** Scripted reviewer verdicts, e.g. a blocking defect to drive the P7 refine loop. */
  reviewResponses?: string[];
  /**
   * Replace the mock provider bundle outright. The escape hatch exists for exactly one
   * caller — `scripts/record-fixture-assets.mjs`, which needs real providers to record
   * against. **No test should pass this**: a suite that reaches a network is not a suite.
   */
  providers?: Providers;
  /**
   * Receive the scheduler's structured events. A failure's message lives only here — the
   * scheduler logs it and does not store it on the task — so without one a wave of failed
   * tasks is indistinguishable from a wave of successful ones in the returned summary.
   */
  logger?: Logger;
}

export interface MakeProjectOptions {
  title?: string;
  /** Merged into the generated `project.yaml`. */
  config?: Record<string, unknown>;
  /** A bare id gets sensible defaults; a spec overrides front-matter fields. */
  characters?: (string | CharacterSpec)[];
  /** Defaults are inferred from the script's scene headings when omitted. */
  locations?: (string | LocationSpec)[];
  /** Fountain source. Default: `SCRIPTS.branching`. */
  script?: string;
  /** `git init` + a deterministic identity + an initial commit of the inputs. */
  git?: boolean;
  /** Extra files, keyed by path relative to the project root. */
  files?: Record<string, string>;
  /**
   * `'cached'` serves **real** recorded art out of the fixture asset cache; anything it has
   * no recording for falls through to a placeholder, and so does everything downstream of
   * that (a ref's bytes are part of the next request's key). Default `'placeholder'`, so an
   * existing suite is untouched and no test can pass only on a machine that has the cache.
   */
  assets?: 'placeholder' | 'cached';
  /** Override the cache directory. Tests point this at a temp dir. */
  assetCacheDir?: string;
}

const DEFAULT_TITLE = 'Testkit Project';
const DEFAULT_ART_STYLE = 'flat fixture illustration';

/** Strip a cue's parenthetical the way `@vn/model` does, then slug it to a character id. */
function cueId(cue: string): string {
  return slug(cue.replace(/\([^)]*\)/g, '').trim());
}

/**
 * Derive the characters and locations a script needs, by splitting it exactly as the real
 * model build does. Cheaper than hand-listing them per fixture, and it cannot drift from
 * the ids `buildModel` will resolve.
 */
function inferInputs(script: string): { characters: CharacterSpec[]; locations: LocationSpec[] } {
  const { scenes, mined } = splitScenes(parseFountain(script));

  const characters = new Map<string, CharacterSpec>();
  for (const scene of scenes) {
    for (const cue of scene.characters) {
      const id = cueId(cue);
      if (id && !characters.has(id)) characters.set(id, { id });
    }
  }

  const locations = new Map<string, LocationSpec>();
  for (const loc of mined) {
    const spec = locations.get(loc.id) ?? { id: loc.id, name: titleCase(loc.id), variants: [] };
    if (!spec.variants!.includes(loc.variant)) spec.variants!.push(loc.variant);
    locations.set(loc.id, spec);
  }

  return { characters: [...characters.values()], locations: [...locations.values()] };
}

/**
 * Initialize a repo with a deterministic identity. A temp dir inherits nothing, so commits
 * fail on a clean box without a local `user.*`; `core.autocrlf false` keeps diffs byte-exact
 * on Windows.
 */
async function initRepo(dir: string): Promise<Git> {
  const git = openGit(dir);
  await git.init();
  await git.config('user.email', 'testkit@example.com');
  await git.config('user.name', 'VN Testkit');
  await git.config('core.autocrlf', 'false');
  await git.commit({ message: 'Fixture inputs', paths: ['-A'] });
  return git;
}

/**
 * A real VN project on disk. Every method goes through the same code paths the CLI does —
 * inputs are parsed from files, approval is written to `character.md`, the scheduler runs
 * with mock providers — so a fixture cannot pass by being kinder than production.
 */
export class TestProject {
  readonly paths: ProjectPaths;
  private state?: ProjectState;
  private imageBackend?: ImageBackend;

  constructor(
    readonly dir: string,
    readonly git?: Git,
    private readonly assets: { mode: 'placeholder' | 'cached'; cacheDir: string } = {
      mode: 'placeholder',
      cacheDir: FIXTURE_ASSET_DIR,
    },
  ) {
    this.paths = new ProjectPaths(dir);
  }

  /** Re-read everything from disk. Call after any edit; `run` does it for you. */
  async reload(): Promise<ProjectState> {
    const config = await loadConfig(this.dir);
    const inputs = await loadInputs(this.paths);
    const model = modelFromInputs(inputs, { title: config.title });
    const store = await AssetStore.open(this.paths);
    const graph = await loadGraph(this.paths);
    this.state = { config, model, store, graph };
    return this.state;
  }

  /** The last `reload()`, reloading first if there has not been one. */
  async current(): Promise<ProjectState> {
    return this.state ?? this.reload();
  }

  /** Reload, then run the real scheduler — with mock providers unless `opts.providers` says otherwise. */
  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const { config, model, store, graph } = await this.reload();
    const providers =
      opts.providers ??
      createMockProviders({
        reviewResponses: opts.reviewResponses,
        refLoader: async (ref) => ({ bytes: await store.read(ref), ext: ref.ext }),
        imageBackend: await this.images(),
      });
    return runPipeline({
      model,
      graph,
      store,
      providers,
      config,
      paths: this.paths,
      dryRun: opts.dryRun,
      logger: opts.logger,
    });
  }

  /**
   * Approve a portrait the way `vngen approve` does — front-matter, the visible
   * `approved.png`, and `store.accept` — so the next `reload()` sees the gate cleared.
   */
  async approve(characterId: string, hash?: string): Promise<string> {
    const { store } = await this.reload();
    const chosen = hash ?? this.portraitsFor(store, characterId)[0]?.hash;
    if (!chosen) {
      throw new Error(`no portrait asset for character "${characterId}" — run() first`);
    }
    if (!(await setCharacterApproval(this.paths, characterId, chosen))) {
      throw new Error(`no character.md for "${characterId}"`);
    }
    await writeApprovedPortrait(
      this.paths,
      characterId,
      await store.read({ hash: chosen, ext: 'png' }),
    );
    await store.accept(chosen);
    return chosen;
  }

  /** Approve every character that has a generated portrait; returns the ids approved. */
  async approveAll(): Promise<string[]> {
    const { model, store } = await this.reload();
    const pending = [...model.characters.keys()].filter(
      (id) => this.portraitsFor(store, id).length > 0,
    );
    for (const id of pending) await this.approve(id);
    return pending;
  }

  write(rel: string, content: string): Promise<void> {
    return writeFileAtomic(join(this.dir, rel), content);
  }

  read(rel: string): Promise<string> {
    return readFile(join(this.dir, rel), 'utf8');
  }

  /** `git diff` over the working tree. Throws when the project has no repo. */
  diff(pathspec?: string): Promise<string> {
    if (!this.git) throw new Error('project was built without `git: true`');
    return this.git.diff(pathspec ? { paths: [pathspec] } : {});
  }

  cleanup(): Promise<void> {
    // Retries: git leaves read-only pack files behind, which Windows refuses to unlink first try.
    return rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  /**
   * The image backend a run uses. `undefined` leaves `createMockProviders` on its stub; in
   * `cached` mode the stub becomes the fallback behind the recorded corpus, so a request
   * with no recording still produces a placeholder rather than failing the run.
   */
  private async images(): Promise<ImageBackend | undefined> {
    if (this.assets.mode !== 'cached') return undefined;
    if (!this.imageBackend) {
      const cache = await AssetCache.open(this.assets.cacheDir);
      this.imageBackend = new CachedImageBackend(cache, new StubImageBackend());
    }
    return this.imageBackend;
  }

  private portraitsFor(store: AssetStore, characterId: string) {
    return store
      .manifest()
      .filter((a) => a.kind === 'portrait' && a.satisfies.characterId === characterId);
  }
}

/** Build a real project on disk from authored inputs. Always `cleanup()` in a `finally`. */
export async function makeProject(opts: MakeProjectOptions = {}): Promise<TestProject> {
  const script = opts.script ?? SCRIPTS.branching;
  const inferred = inferInputs(script);
  const characters = (opts.characters ?? inferred.characters).map((c) => toSpec<CharacterSpec>(c));
  const locations = (opts.locations ?? inferred.locations).map((l) => toSpec<LocationSpec>(l));
  const config = {
    title: opts.title ?? DEFAULT_TITLE,
    art_style: DEFAULT_ART_STYLE,
    ...opts.config,
  };

  const dir = await mkdtemp(join(tmpdir(), 'vn-testkit-'));
  const paths = new ProjectPaths(dir);
  await writeFileAtomic(paths.projectConfig, projectYaml(config));
  for (const spec of characters) {
    await writeFileAtomic(paths.characterFile(spec.id), characterDoc(spec));
  }
  for (const spec of locations) {
    await writeFileAtomic(join(paths.locationsDir, `${spec.id}.md`), locationDoc(spec));
  }
  await writeFileAtomic(join(paths.screenplayDir, 'script.fountain'), script);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    await writeFileAtomic(join(dir, rel), content);
  }

  return new TestProject(dir, opts.git ? await initRepo(dir) : undefined, {
    mode: opts.assets ?? 'placeholder',
    cacheDir: opts.assetCacheDir ?? FIXTURE_ASSET_DIR,
  });
}

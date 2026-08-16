/**
 * The image seam: how a `vnauthor` run gets a picture made.
 *
 * The tool takes an `ArtGen` and never constructs a provider, exactly as it never decides its own
 * permissions — whether this run is mocked and where the keys live is the host's business. The
 * agent core stops at authored inputs, and a concept is one: a sketch bound to the entity it is of,
 * that nothing in the pipeline plans, renders or exports.
 */
import { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';
import { modelFromInputs } from '@vn/model';
import { AssetStore, loadInputs } from '@vn/store';
import {
  RecordedChatBackend,
  chatBackendFor,
  chatVendorFor,
  createMockProviders,
  createProviders,
  type ChatBackend,
} from '@vn/providers';
import {
  bindingSubject,
  conceptPrompt,
  describeAsset,
  generateConcept,
  matchSubject,
  redrawConcept,
  subjectEntity,
  type ConceptRequest,
  type ConceptResult,
  type ConceptSubject,
  type DescribeRequest,
  type DescribeResult,
  type RedrawRequest,
  type RedrawResult,
} from '@vn/artgen';
import { VnError } from '@vn/util';
import type { Workspace } from './workspace.js';

// The subject vocabulary travels with the seam: a host surface that offers `/makeimage` needs to
// say what it bound to and to parse an override, and must not import `@vn/artgen` to do it.
export { formatSubject, parseSubject, type ConceptSubject } from '@vn/artgen';

/** What {@link ArtGen.preview} answers: the picture that *would* be drawn, for the price of a read. */
export interface ConceptPreview {
  prompt: string;
  subject?: ConceptSubject;
}

/** One concept the project holds, as {@link ArtGen.list} reports it. */
export interface ConceptListing {
  hash: string;
  /** Absolute, like {@link ConceptResult.file}; the caller decides what to show. */
  file: string;
  title?: string;
  /** The prompt it was drawn from — the one prompt in the project that is authored, so editable. */
  prompt?: string;
  subject?: ConceptSubject;
}

/** What `generate_image` is handed. Narrow on purpose: a tool asks for a picture, not a provider. */
export interface ArtGen {
  generate(req: ConceptRequest): Promise<ConceptResult>;
  /** Compose the prompt and resolve the subject without spending a generation — what plan mode shows. */
  preview(req: ConceptRequest): Promise<ConceptPreview>;
  /** Draw a concept again from an edited prompt. A new sketch; the original stays where it is. */
  redraw(req: RedrawRequest): Promise<RedrawResult>;
  /** Every concept the project holds. A hash is not memorable, so nothing can be edited unlisted. */
  list(): Promise<ConceptListing[]>;
  /** Look at one stored picture and answer a question about it. Costs a vision call. */
  describe(req: DescribeRequest): Promise<DescribeResult>;
}

/**
 * An `ArtGen` bound to a workspace, re-reading the project on every call: a sketch asked for after
 * an edit must be drawn from the sheet as edited, and a long-lived REPL outlives any snapshot.
 *
 * `mock` produces the marked placeholder a mock provider always produces — the same offline
 * behaviour `vngen run --mock` has, and the marker is what keeps it out of a real run.
 */
export function workspaceArtGen(workspace: Workspace, opts: { mock?: boolean } = {}): ArtGen {
  /** The project as it is right now, plus the ref loader both halves need. */
  async function open() {
    const config = await loadConfig(workspace.root);
    const model = modelFromInputs(await loadInputs(workspace.paths), {
      title: config.title,
      start: config.start,
    });
    const store = await AssetStore.open(workspace.paths);
    const loadRef = async (ref: { hash: string; ext: string }) => ({
      bytes: await store.read(ref),
      ext: ref.ext,
    });
    return { config, model, store, loadRef };
  }

  /** The image provider for this run: mocked, or real against keys resolved by source. */
  async function imageOf(
    config: Awaited<ReturnType<typeof loadConfig>>,
    loadRef: (ref: { hash: string; ext: string }) => Promise<{ bytes: Uint8Array; ext: string }>,
  ) {
    const providers = opts.mock
      ? createMockProviders({ refLoader: loadRef })
      : createProviders({
          config,
          keys: await resolveKeys(config, {
            secretsDirs: await secretDirsFor(workspace.root),
            require: ['gemini'],
          }),
          loadRef,
        });
    return providers.image;
  }

  /**
   * The vision model for a read-back — the first `models.vision` entry, which is the reviewer the
   * pipeline would have used. Mocked, it answers the same sentence every time and says what it is:
   * a stub that never looked at the picture must not read as a description of one.
   */
  async function visionOf(config: Awaited<ReturnType<typeof loadConfig>>): Promise<ChatBackend> {
    if (opts.mock) {
      return new RecordedChatBackend(
        'mock-vision',
        () => 'A mock vision backend does not look at pictures, so there is nothing to report.',
      );
    }
    const modelId = config.models.vision[0];
    if (!modelId) {
      throw new VnError('NO_VISION_MODEL', 'project.yaml names no models.vision to look with.');
    }
    const keys = await resolveKeys(config, {
      secretsDirs: await secretDirsFor(workspace.root),
      require: [chatVendorFor(modelId)],
    });
    return chatBackendFor(modelId, keys).backend;
  }

  return {
    async generate(req: ConceptRequest): Promise<ConceptResult> {
      const { config, model, store, loadRef } = await open();
      const image = await imageOf(config, loadRef);
      return generateConcept({ config, model, store, image }, req);
    },

    async redraw(req: RedrawRequest): Promise<RedrawResult> {
      const { config, model, store, loadRef } = await open();
      const image = await imageOf(config, loadRef);
      return redrawConcept({ config, model, store, image }, req);
    },

    async list(): Promise<ConceptListing[]> {
      const { store } = await open();
      return store
        .manifest()
        .filter((a) => a.kind === 'concept')
        .map((a) => {
          const subject = bindingSubject(a.satisfies[0]);
          return {
            hash: a.hash,
            file: store.pathOf({ hash: a.hash, ext: a.ext }),
            ...(a.title ? { title: a.title } : {}),
            ...(a.prompt ? { prompt: a.prompt } : {}),
            ...(subject ? { subject } : {}),
          };
        });
    },

    async describe(req: DescribeRequest): Promise<DescribeResult> {
      const { config, store } = await open();
      return describeAsset({ store, backend: await visionOf(config) }, req);
    },

    async preview(req: ConceptRequest): Promise<ConceptPreview> {
      const sentence = req.sentence.trim();
      if (!sentence)
        throw new VnError('CONCEPT_EMPTY', 'Nothing to draw: the description is empty.');
      const { config, model } = await open();
      const subject = req.subject ?? matchSubject(model, sentence);
      if (subject && !subjectEntity(model, subject)) {
        throw new VnError('UNKNOWN_SUBJECT', `No ${subject.kind} "${subject.id}" in this project.`);
      }
      return {
        prompt: conceptPrompt(sentence, subject, model, config),
        ...(subject ? { subject } : {}),
      };
    },
  };
}

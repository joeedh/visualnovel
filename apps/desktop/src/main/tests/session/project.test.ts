import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { WorkspaceSession } from '../../session.js';
import { sessionFor } from './helpers.js';

describe('WorkspaceSession — project settings', () => {
  let p: TestProject;
  let session: WorkspaceSession;

  beforeAll(async () => {
    p = await makeProject({ title: 'Settings', script: SCRIPTS.linear });
    session = sessionFor(p);
  });

  afterAll(async () => {
    await p.cleanup();
  });

  it('reports project.yaml as the run reads it', async () => {
    const view = await session.projectView();
    expect(view).toMatchObject({ root: p.dir, title: 'Settings' });
    expect(view.models.image.length).toBeGreaterThan(0);
    expect(view.imageParams.aspect.length).toBeGreaterThan(0);
  });

  it('writes the art style and reads it back', async () => {
    const result = await session.setProjectArtStyle('ink wash, muted');
    expect(result).toMatchObject({ ok: true, written: ['project.yaml'] });
    expect((await session.projectView()).artStyle).toBe('ink wash, muted');
    // The splice is textual, so the rest of the file has to survive it
    expect(await p.read('project.yaml')).toContain('title: Settings');
  });

  it('refuses a style the project already says, rather than rewriting the file', async () => {
    await session.setProjectArtStyle('ink wash, muted');
    expect(await session.previewArtStyle('ink wash, muted')).toMatchObject({ ok: false });
    expect(await session.setProjectArtStyle('ink wash, muted')).toMatchObject({
      ok     : false,
      written: [],
    });
  });

  // The count is what the confirmation is for, because an art style is not art notes on one rung
  it('counts the image tasks a change would re-key', async () => {
    const preview = await session.previewArtStyle('something else');
    expect(preview.ok).toBe(true);
    expect(preview.message).toMatch(/re-keys \d+ image task/);
  });

  it('refuses an image model no key can carry, naming the key and Setup', async () => {
    const had = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = '';
    try {
      expect(await session.previewImageModel('openai/gpt-image-2')).toEqual({
        ok     : false,
        message:
          'missing openrouter API key for openai/gpt-image-2: set $OPENROUTER_API_KEY or place openrouter.txt in a keys/ dir; provide one in Setup first',
      });
      expect(await session.previewImageModel('   ')).toMatchObject({ ok: false });
      expect(await p.read('project.yaml')).not.toContain('openai/gpt-image-2');
    } finally {
      if (had === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = had;
    }
  });

  it('writes the image model into the models block once its vendor has a key', async () => {
    await session.setKey('openrouter', 'not-a-real-key');
    const preview = await session.previewImageModel('openai/gpt-image-2');
    expect(preview.ok).toBe(true);
    expect(preview.message).toMatch(
      /^Set the image model to `openai\/gpt-image-2`\. Pictures already drawn stay; \d+ image task\(s\) still to draw, and anything regenerated, will use it\.$/,
    );

    const result = await session.setProjectImageModel('openai/gpt-image-2');
    expect(result).toMatchObject({ ok: true, written: ['project.yaml'] });
    expect((await session.projectView()).models.image).toBe('openai/gpt-image-2');
    expect(await p.read('project.yaml')).toContain('title: Settings');
    expect(await session.previewImageModel('openai/gpt-image-2')).toMatchObject({ ok: false });
  });

  // jest sets `$VNAUTHOR_HOME` per worker, so the listing lands in a directory this worker owns
  it('caches the OpenRouter listing for the pickers, and leaves it alone when the fetch fails', async () => {
    const answer = (body: unknown, status = 200): Response =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    const listing = {
      data: [
        {
          id                  : 'openai/gpt-image-2',
          name                : 'GPT Image 2',
          supported_parameters: { aspect_ratio: { values: ['1:1'] } },
        },
      ],
    };
    const priced = {
      endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.05 }] }],
    };
    const textListing = {
      data: [
        {
          id          : 'anthropic/claude-opus-4.8',
          name        : 'Claude Opus 4.8',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ],
    };
    // Routed by URL: the vendor listings answer empty whatever keys this machine has set, so the
    // count below is the OpenRouter text listing's alone
    const fetchImpl = ((url: string) => {
      if (url.endsWith('/endpoints')) return Promise.resolve(answer(priced));
      if (url.startsWith('https://api.anthropic.com/'))
        return Promise.resolve(answer({ data: [] }));
      if (url.startsWith('https://generativelanguage.googleapis.com/')) {
        return Promise.resolve(answer({ models: [] }));
      }
      if (url === 'https://openrouter.ai/api/v1/models')
        return Promise.resolve(answer(textListing));
      return Promise.resolve(answer(listing));
    }) as never;

    const before = (await session.projectView()).imageModels;
    expect(before.openrouter).toEqual([]);
    expect(before.asOf).toBeUndefined();
    expect(before.shipped).toContain('gemini-2.5-flash-image');

    const done = await session.refreshModelCatalog(fetchImpl);
    expect(done).toMatchObject({ ok: true, listed: 2 });
    expect((done as { message: string }).message).toMatch(
      /^Listed 1 OpenRouter image model\(s\) as of \d{4}-\d{2}-\d{2}, 1 with a per-picture price\. Listed 1 text model\(s\)/,
    );
    const after = (await session.projectView()).imageModels;
    expect(after.openrouter).toEqual([
      {
        id      : 'openai/gpt-image-2',
        name    : 'GPT Image 2',
        aspects : ['1:1'],
        seed    : false,
        priceUsd: 0.05,
      },
    ]);
    expect(after.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.default).toBe('openai/gpt-image-2');
    expect(after.text).toEqual([
      { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', vendor: 'openrouter' },
    ]);

    const failing = (() => Promise.resolve(answer('busy', 503))) as never;
    expect(await session.refreshModelCatalog(failing)).toEqual({
      ok    : false,
      reason: '503 OpenRouter: busy',
    });
    expect((await session.projectView()).imageModels).toEqual(after);
  });

  it('writes the storyboard notes beside the art style, and says they re-key nothing', async () => {
    const preview = await session.previewStoryboardNotes('pages of four to six panels');
    expect(preview).toMatchObject({ ok: true });
    expect(preview.message).toMatch(/no shot already written is re-keyed/);

    const result = await session.setProjectStoryboardNotes('pages of four to six panels');
    expect(result).toMatchObject({ ok: true, written: ['project.yaml'] });
    expect(await p.read('project.yaml')).toContain('storyboard_notes: pages of four to six panels');
    expect(await p.read('project.yaml')).toContain('art_style: ink wash, muted');
    expect(await session.setProjectStoryboardNotes('pages of four to six panels')).toMatchObject({
      ok     : false,
      written: [],
    });
  });

  it('writes the lettering mode and prices the page shots it re-keys', async () => {
    // The runner letters by default, so the change with a price is to the model
    expect(await session.previewLettering('runner')).toMatchObject({ ok: false });
    const preview = await session.previewLettering('model');
    expect(preview.ok).toBe(true);
    expect(preview.message).toMatch(/re-keys \d+ of them/);

    expect(await session.setProjectLettering('model')).toMatchObject({
      ok     : true,
      written: ['project.yaml'],
    });
    expect(await p.read('project.yaml')).toContain('lettering: model');
    expect(await session.previewLettering('model')).toMatchObject({ ok: false });
  });
});

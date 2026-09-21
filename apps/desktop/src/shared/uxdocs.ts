/**
 * The UX docs tree the authoring agent reads: `ux-model.json` re-keyed by command and rendered as
 * Markdown pages (`docs/plans/archive/agent-reads-the-ux-model.md`).
 *
 * The model is stored as situation × control, and the agent's questions are keyed by command:
 * which pane draws it, which props the control already knows, when it is refused and what the
 * refusal says. {@link fold} answers those by turning the records into one {@link UxPage} per
 * command or effect, and {@link render} writes each page as Markdown with one table row per fact.
 * The fold is typed and strict so a rule module emitting a shape it does not expect fails the
 * build by name; the pages are golden-tested. `scripts/gen-ux-docs.mjs` runs both and writes
 * `apps/desktop/dist/ux/`, which ships inside the asar; nothing here touches the disk.
 */
import { z } from 'zod';
import type {
  DocCommandEntry,
  EffectCatalogEntry,
  InteractionCatalogEntry,
  PropValue,
} from '@vn/commands';
import { ANCHOR_HOMES } from './editors.js';
import {
  actionsOf,
  paletteMatches,
  UX_SHORTCUT,
  type UxModel,
  type UxRecord,
  type UxShortcut,
} from './uxmodel.js';

const propValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const props = z.record(z.string(), propValue);
const editor = z.enum(ANCHOR_HOMES as [string, ...string[]]);

/** `DocProp`, restated so the intermediate is closed. */
const docProp = z
  .object({
    name       : z.string().min(1),
    kind       : z.string().min(1),
    description: z.string(),
    required   : z.boolean(),
    default    : propValue.optional(),
    values     : z.array(z.string()).optional(),
    digest     : z.boolean().optional(),
  })
  .strict();

/** `DocCommandEntry`, the one projection of the registry that carries `notes`. */
const docEntry = z
  .object({
    id         : z.string().min(1),
    namespace  : z.string().min(1),
    title      : z.string(),
    description: z.string(),
    mutating   : z.boolean(),
    confirm    : z.boolean(),
    undoable   : z.boolean(),
    checkable  : z.boolean(),
    affects    : z.array(z.string()).optional(),
    notes      : z.string().optional(),
    props      : z.array(docProp),
  })
  .strict();

/** `CatalogProp` as an effect's entry carries it. */
const catalogProp = docProp
  .extend({ multiline: z.boolean().optional(), hint: z.string().optional() })
  .strict();

/** `EffectCatalogEntry`: the id, the two sentences, and the props. */
const effectEntry = z
  .object({
    id         : z.string().min(1),
    title      : z.string(),
    description: z.string(),
    props      : z.array(catalogProp),
  })
  .strict();

/** `InteractionCatalogEntry`: everything about a gesture except `targets`. */
const interaction = z
  .object({
    id         : z.string().min(1),
    title      : z.string(),
    description: z.string(),
    grab       : z.string(),
    carries    : z.string(),
    accepts    : z.string(),
    commands   : z.array(z.string()),
    cancellable: z.boolean(),
  })
  .strict();

const situated = { editor, module: z.string().min(1), situation: z.string().min(1) };

/**
 * One accepted control, folded across the situations that do not change it. `then` is what the
 * click does after this page's action, by id.
 */
const row = z
  .object({
    editor,
    module    : z.string().min(1),
    situations: z.array(z.string().min(1)).min(1),
    label     : z.string(),
    tooltip   : z.string(),
    props,
    then: z.array(z.string().min(1)),
  })
  .strict();

/** One refusal, verbatim from the fixture. `more` is the refusal's longer `description`. */
const refusal = z
  .object({
    ...situated,
    says      : z.string().min(1),
    more      : z.string().optional(),
    reasonFrom: z.literal('stack').optional(),
  })
  .strict();

/** A record whose click runs this page's action after `first`. */
const after = z.object({ ...situated, first: z.string().min(1) }).strict();

/** A menu entry running this page's action, with `when` in the prefix form the model uses. */
const menu = z
  .object({ ...situated, when: z.string().min(1), label: z.string(), props: props.optional() })
  .strict();

export const UX_PAGE = z
  .object({
    id          : z.string().min(1),
    kind        : z.enum(['command', 'effect']),
    doc         : docEntry.optional(),
    effect      : effectEntry.optional(),
    drawn       : z.array(row),
    refused     : z.array(refusal),
    reachedAfter: z.array(after),
    anchored    : z.boolean(),
    paletteOnly : z.string().optional(),
    shortcuts   : z.array(z.string().min(1)),
    menus       : z.array(menu),
  })
  .strict();

/** One control as an editor's page lists it: the key, what it runs first, and its verdict. */
const listed = z
  .object({
    key  : z.string().min(1),
    runs : z.string().min(1),
    label: z.string(),
    ok   : z.boolean(),
    says : z.string().optional(),
  })
  .strict();

const editorSituation = z
  .object({ name: z.string().min(1), why: z.string().min(1), controls: z.array(listed) })
  .strict();

export const UX_EDITOR = z
  .object({
    id     : editor,
    modules: z.array(
      z.object({ module: z.string().min(1), situations: z.array(editorSituation) }).strict(),
    ),
  })
  .strict();

/** One control across a module's situations: accepted, refused, or not offered at all. */
const flip = z
  .object({
    key     : z.string().min(1),
    runs    : z.string().min(1),
    label   : z.string(),
    verdicts: z.record(z.string(), z.enum(['ok', 'refused'])),
  })
  .strict();

export const UX_MODULE_SITUATIONS = z
  .object({
    module: z.string().min(1),
    editor,
    situations: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) }).strict()),
    controls  : z.array(flip),
  })
  .strict();

export const UX_DOCS = z
  .object({
    swept       : z.object({ at: z.string().min(1), sha: z.string().min(1) }).strict(),
    commands    : z.array(UX_PAGE),
    effects     : z.array(UX_PAGE),
    editors     : z.array(UX_EDITOR),
    situations  : z.array(UX_MODULE_SITUATIONS),
    interactions: z.array(interaction),
    shortcuts   : z.array(UX_SHORTCUT),
  })
  .strict();

export type UxPage = z.infer<typeof UX_PAGE>;
export type UxRow = z.infer<typeof row>;
export type UxRefusal = z.infer<typeof refusal>;
export type UxAfter = z.infer<typeof after>;
export type UxMenu = z.infer<typeof menu>;
export type UxEditor = z.infer<typeof UX_EDITOR>;
export type UxModuleSituations = z.infer<typeof UX_MODULE_SITUATIONS>;
export type UxDocs = z.infer<typeof UX_DOCS>;

/** The four fields of `anchors.json` the pages read. The file carries more; none of it is here. */
export const UX_ANCHORS = z.object({
  sweptAt : z.string().min(1),
  gitSha  : z.string().min(1),
  anchored: z.array(z.string()),
  effects : z.array(z.string()),
});

export type UxAnchors = z.infer<typeof UX_ANCHORS>;

/** The modifier order `comboOf` in `renderer/rules/shortcuts.ts` uses. */
const MODS = ['ctrl', 'shift', 'alt'];

/** A shortcut as a person reads it, with its scope where the binding is not global. */
function comboOf(entry: UxShortcut): string {
  const mods = MODS.filter((mod) => entry.mods.includes(mod)).map(
    (mod) => mod[0]!.toUpperCase() + mod.slice(1),
  );
  const keys = [...mods, entry.key].join('+');
  return entry.scope === 'global' ? keys : `${keys} (${entry.scope})`;
}

/** A blank page, before any record lands on it. */
function emptyPage(id: string, kind: UxPage['kind']): UxPage {
  return {
    id,
    kind,
    drawn       : [],
    refused     : [],
    reachedAfter: [],
    anchored    : false,
    shortcuts   : [],
    menus       : [],
  };
}

const sameProps = (a: Record<string, PropValue>, b: Record<string, PropValue>): boolean =>
  JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** The row an accepted control folds into, or a new one when nothing on the page matches. */
function rowFor(page: UxPage, want: Omit<UxRow, 'situations'>): UxRow {
  const found = page.drawn.find(
    (r) =>
      r.editor === want.editor &&
      r.module === want.module &&
      r.label === want.label &&
      r.tooltip === want.tooltip &&
      sameProps(r.props, want.props) &&
      r.then.join(' ') === want.then.join(' '),
  );
  if (found) return found;
  const made: UxRow = { ...want, situations: [] };
  page.drawn.push(made);
  return made;
}

/** Whether `list` already holds an entry equal to `item` field for field. */
function has<T extends object>(list: readonly T[], item: T): boolean {
  const key = JSON.stringify(item, Object.keys(item).sort());
  return list.some((have) => JSON.stringify(have, Object.keys(have).sort()) === key);
}

/**
 * Re-key the model by command. Every registry command and every effect gets a page; a record
 * lives on its first action's page and each later action's page gets a "Reached after" row.
 * A record whose first action names neither throws, which is what fails the build by name.
 */
export function fold(
  model: UxModel,
  anchors: UxAnchors,
  docs: readonly DocCommandEntry[],
  interactions: readonly InteractionCatalogEntry[],
  effects: readonly EffectCatalogEntry[],
): UxDocs {
  const pages = new Map<string, UxPage>();
  for (const doc of docs) {
    pages.set(doc.id, { ...emptyPage(doc.id, 'command'), doc: docEntry.parse(doc) });
  }
  for (const effect of effects) {
    pages.set(effect.id, { ...emptyPage(effect.id, 'effect'), effect: effectEntry.parse(effect) });
  }
  const pageOf = (id: string, record: UxRecord): UxPage => {
    const page = pages.get(id);
    if (page === undefined) {
      throw new Error(
        `${record.module}/${record.situation}: action "${id}" is neither a command nor an effect`,
      );
    }
    return page;
  };

  for (const record of model.records) {
    const [first, ...rest] = actionsOf(record);
    const page = pageOf(first!.id, record);
    const at = { editor: record.editor, module: record.module, situation: record.situation };
    if (record.via === 'control') {
      const offer = record.offer;
      if (offer.ok) {
        const folded = rowFor(page, {
          editor : record.editor,
          module : record.module,
          label  : offer.label,
          tooltip: offer.tooltip,
          props  : offer.props,
          then   : rest.map((step) => step.id),
        });
        if (!folded.situations.includes(record.situation)) {
          folded.situations.push(record.situation);
        }
      } else {
        page.refused.push({
          ...at,
          says: offer.refusal.reason,
          ...(offer.refusal.description === undefined ? {} : { more: offer.refusal.description }),
          ...(record.reasonFrom === undefined ? {} : { reasonFrom: record.reasonFrom }),
        });
      }
    } else {
      page.menus.push({
        ...at,
        when : record.when,
        label: record.label,
        ...(record.props === undefined ? {} : { props: record.props }),
      });
      if (record.refused !== undefined) page.refused.push({ ...at, says: record.refused });
    }
    for (const step of rest) {
      const later = pageOf(step.id, record);
      const reached = { ...at, first: first!.id };
      if (!has(later.reachedAfter, reached)) later.reachedAfter.push(reached);
    }
  }

  const drawnIds = new Set([...anchors.anchored, ...anchors.effects]);
  for (const page of pages.values()) {
    page.anchored = drawnIds.has(page.id);
    const rule = model.paletteOnly.find((entry) => paletteMatches(entry.match, page.id));
    if (rule !== undefined) page.paletteOnly = rule.why;
    page.shortcuts = [
      ...new Set(model.shortcuts.filter((s) => s.runs.id === page.id).map(comboOf)),
    ];
  }

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const all = [...pages.values()].sort(byId);
  return {
    swept       : { at: anchors.sweptAt, sha: anchors.gitSha },
    commands    : all.filter((page) => page.kind === 'command'),
    effects     : all.filter((page) => page.kind === 'effect'),
    editors     : foldEditors(model),
    situations  : foldSituations(model),
    interactions: interactions.map((entry) => interaction.parse(entry)),
    shortcuts   : [...model.shortcuts],
  };
}

/** A record as a listing names it: its key, its first action, its label and its verdict. */
function listing(record: UxRecord): z.infer<typeof listed> {
  const runs = actionsOf(record)[0]!.id;
  if (record.via === 'control') {
    const offer = record.offer;
    return offer.ok
      ? { key: record.key, runs, label: offer.label, ok: true }
      : { key: record.key, runs, label: offer.label, ok: false, says: offer.refusal.reason };
  }
  return {
    key: `menu:${record.when} ${record.id}`,
    runs,
    label: record.label,
    ok   : record.refused === undefined,
    ...(record.refused === undefined ? {} : { says: record.refused }),
  };
}

/** What each editor draws, grouped by module and then by situation, in the model's own order. */
function foldEditors(model: UxModel): UxEditor[] {
  const editors = new Map<string, UxEditor>();
  for (const situation of model.situations) {
    const home = editors.get(situation.editor) ?? { id: situation.editor, modules: [] };
    editors.set(situation.editor, home);
    let mod = home.modules.find((m) => m.module === situation.module);
    if (mod === undefined) {
      mod = { module: situation.module, situations: [] };
      home.modules.push(mod);
    }
    mod.situations.push({ name: situation.name, why: situation.why, controls: [] });
  }
  for (const record of model.records) {
    const target = editors
      .get(record.editor)
      ?.modules.find((m) => m.module === record.module)
      ?.situations.find((s) => s.name === record.situation);
    if (target === undefined) {
      throw new Error(`${record.module}/${record.situation} is not a listed situation`);
    }
    target.controls.push(listing(record));
  }
  return [...editors.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Every situation of each module, and each control's verdict across them. */
function foldSituations(model: UxModel): UxModuleSituations[] {
  const modules = new Map<string, UxModuleSituations>();
  for (const situation of model.situations) {
    const mod = modules.get(situation.module) ?? {
      module    : situation.module,
      editor    : situation.editor,
      situations: [],
      controls  : [],
    };
    modules.set(situation.module, mod);
    mod.situations.push({ name: situation.name, why: situation.why });
  }
  for (const record of model.records) {
    const mod = modules.get(record.module)!;
    const entry = listing(record);
    let control = mod.controls.find((c) => c.key === entry.key);
    if (control === undefined) {
      control = { key: entry.key, runs: entry.runs, label: entry.label, verdicts: {} };
      mod.controls.push(control);
    }
    control.verdicts[record.situation] = entry.ok ? 'ok' : 'refused';
  }
  return [...modules.values()].sort((a, b) => a.module.localeCompare(b.module));
}

/** The one escape a cell needs. A newline would end the row, so it becomes a space. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

const code = (text: string): string => `\`${cell(text)}\``;

/** A prop value as a row spells it: bare, a list in brackets. */
function spell(value: PropValue): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

/** A default as the command table spells it: a string in quotes, so an empty one is visible. */
function spellDefault(value: PropValue): string {
  return typeof value === 'string' ? `'${value}'` : spell(value);
}

/** Props as `name=value`, so the model reads them the way it writes a step's `props`. */
function formatProps(values: Record<string, PropValue>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${spell(value)}`)
    .join(', ');
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** The page's path under the tree root, forward-slashed. */
export function pagePath(page: Pick<UxPage, 'id' | 'kind'>): string {
  if (page.kind === 'effect') return `effects/${page.id}.md`;
  const dot = page.id.indexOf('.');
  return `commands/${page.id.slice(0, dot)}/${page.id.slice(dot + 1)}.md`;
}

/** The one line every "Refused when" table repeats, so a sentence is never read as this project's. */
const VERBATIM =
  "Sentences are a fixture's, verbatim: an id in one is the fixture's, not this project's.";

function propsTable(list: z.infer<typeof catalogProp>[]): string {
  if (list.length === 0) return 'None.';
  return table(
    ['Prop', 'Type', 'Required', 'Description'],
    list.map((prop) => {
      const kind =
        prop.kind === 'enum' && prop.values
          ? prop.values.map((v) => `\`${v}\``).join(', ')
          : prop.kind;
      const extras = [
        prop.default === undefined ? '' : ` Default ${code(spellDefault(prop.default))}.`,
        prop.digest ? ' Bulk content, passed as a digest.' : '',
      ].join('');
      return [
        code(prop.name),
        cell(kind),
        prop.required ? 'yes' : 'no',
        cell(prop.description) + extras,
      ];
    }),
  );
}

function reachingIt(docs: UxDocs, page: UxPage): string {
  const sweep = `the sweep of ${docs.swept.at.slice(0, 10)} at ${docs.swept.sha.slice(0, 7)}`;
  const lines = [
    `- Sweep: ${page.anchored ? `a control or menu entry ran it in ${sweep}.` : `nothing ran it in ${sweep}.`}`,
    `- Palette-only rule: ${page.paletteOnly === undefined ? 'none.' : cell(page.paletteOnly)}`,
    `- Shortcut: ${page.shortcuts.length === 0 ? 'none.' : page.shortcuts.map(code).join(', ')}`,
  ];
  if (page.menus.length === 0) {
    lines.push('- Menu: none.');
  } else {
    const seen = new Set<string>();
    for (const m of page.menus) {
      const props =
        m.props === undefined || Object.keys(m.props).length === 0
          ? ''
          : ` with ${code(formatProps(m.props))}`;
      const line = `- Menu: ${m.module} (${m.editor}) on ${code(m.when)} — "${cell(m.label)}"${props}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines.join('\n');
}

function renderPage(docs: UxDocs, page: UxPage): string {
  const out: string[] = [`# ${page.id}`, ''];
  if (page.kind === 'effect') {
    const effect = page.effect!;
    out.push(
      `**${cell(effect.title)}** — ${cell(effect.description)}`,
      '',
      `${code(page.id)} is an effect, not a command: a \`show_me\` step of kind \`command\` naming it is refused. A tour reaches it by pointing at the control, shortcut or menu entry under "Reaching it".`,
      '',
      '## Props',
      '',
      propsTable(effect.props),
      '',
    );
  } else {
    const doc = page.doc!;
    out.push(`**${cell(doc.title)}** — ${cell(doc.description)}`, '');
    if (doc.notes !== undefined) out.push(cell(doc.notes), '');
    const facts = doc.mutating
      ? [
          'Mutating',
          ...(doc.confirm ? ['asks for confirmation'] : []),
          ...(doc.undoable ? ['undoable'] : []),
          ...(doc.affects && doc.affects.length > 0
            ? [`affects: ${doc.affects.map(code).join(', ')}`]
            : []),
          ...(doc.checkable ? ['has a precondition (ask `ux_check`)'] : []),
        ]
      : ['Read-only'];
    out.push(facts.join(' · '), '', '## Props', '', propsTable(doc.props), '');
  }

  out.push('## Drawn by', '');
  if (page.drawn.length === 0) {
    out.push('No pane draws a control for it.', '');
  } else {
    out.push(
      table(
        ['Editor', 'Module', 'Situations', 'Label', 'Tooltip', 'Props known', 'Then'],
        page.drawn.map((r) => [
          r.editor,
          r.module,
          r.situations.join(', '),
          cell(r.label),
          cell(r.tooltip),
          cell(formatProps(r.props)),
          r.then.join(' → '),
        ]),
      ),
      '',
    );
  }

  out.push('## Refused when', '');
  if (page.refused.length === 0) {
    out.push('Never, in any fixture.', '');
  } else {
    out.push(
      VERBATIM,
      '',
      table(
        ['Editor', 'Module', 'Situation', 'Says', 'More'],
        page.refused.map((r) => [
          r.editor,
          r.module,
          r.situation,
          cell(r.says),
          cell(r.more ?? ''),
        ]),
      ),
      '',
    );
  }

  out.push('## Reached after', '');
  if (page.reachedAfter.length === 0) {
    out.push('Nothing runs it as a later step of a click.', '');
  } else {
    out.push(
      table(
        ['Editor', 'Module', 'Situation', 'First runs'],
        page.reachedAfter.map((r) => [r.editor, r.module, r.situation, code(r.first)]),
      ),
      '',
    );
  }

  out.push('## Reaching it', '', reachingIt(docs, page), '');
  return out.join('\n');
}

function renderEditor(home: UxEditor): string {
  const out = [
    `# ${home.id}`,
    '',
    'What the pane draws, by rule module and then by situation.',
    '',
  ];
  for (const mod of home.modules) {
    out.push(`## ${mod.module}`, '');
    for (const situation of mod.situations) {
      out.push(`### ${situation.name}`, '', cell(situation.why), '');
      if (situation.controls.length === 0) {
        out.push('Draws nothing.', '');
        continue;
      }
      out.push(
        table(
          ['Control', 'Runs', 'Label', 'Verdict'],
          situation.controls.map((c) => [
            code(c.key),
            code(c.runs),
            cell(c.label),
            c.ok ? 'ok' : `refused: ${cell(c.says ?? '')}`,
          ]),
        ),
        '',
      );
    }
  }
  return out.join('\n');
}

function renderSituations(mod: UxModuleSituations): string {
  const out = [
    `# ${mod.module}`,
    '',
    `The situations \`renderer/rules/situations/${mod.module}.ts\` lists for the ${mod.editor} pane, and which offers flip between them.`,
    '',
    table(
      ['Situation', 'Why'],
      mod.situations.map((s) => [s.name, cell(s.why)]),
    ),
    '',
    '## Offers',
    '',
    '`ok` is drawn enabled, `refused` is drawn greyed, blank is not drawn.',
    '',
  ];
  const names = mod.situations.map((s) => s.name);
  out.push(
    table(
      ['Control', 'Runs', ...names],
      mod.controls.map((c) => [
        code(c.key),
        code(c.runs),
        ...names.map((n) => c.verdicts[n] ?? ''),
      ]),
    ),
    '',
  );
  return out.join('\n');
}

function renderInteraction(entry: UxDocs['interactions'][number]): string {
  return [
    `# ${entry.id}`,
    '',
    `**${cell(entry.title)}** — ${cell(entry.description)}`,
    '',
    `- Grab: ${cell(entry.grab)}`,
    `- Carries: ${cell(entry.carries)}`,
    `- Accepts: ${cell(entry.accepts)}`,
    `- Commands a drop can run: ${entry.commands.length === 0 ? 'none' : entry.commands.map(code).join(', ')}`,
    `- Cancellable: ${entry.cancellable ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

function renderShortcuts(shortcuts: readonly UxShortcut[]): string {
  return [
    '# Shortcuts',
    '',
    'Every key binding, from `renderer/rules/shortcuts.ts`. `On` narrows a binding to one control; `Shadows` marks an editor binding that takes a combination the shell also binds.',
    '',
    table(
      ['Scope', 'Keys', 'Label', 'Runs', 'On', 'Shadows'],
      shortcuts.map((s) => [
        s.scope,
        code(comboOf({ ...s, scope: 'global' })),
        cell(s.label),
        code(
          s.runs.props === undefined || Object.keys(s.runs.props).length === 0
            ? s.runs.id
            : `${s.runs.id} ${formatProps(s.runs.props)}`,
        ),
        s.on === undefined ? '' : code(s.on),
        s.shadows ? 'yes' : '',
      ]),
    ),
    '',
  ].join('\n');
}

function renderReadme(docs: UxDocs): string {
  return `# How the app's controls answer to commands

Generated from the derived UX model (\`apps/desktop/ux-model.json\`), the anchor sweep of ${docs.swept.at.slice(0, 10)} at ${docs.swept.sha.slice(0, 7)}, and the command registry. Read it with \`ux_list\`, \`ux_read\` and \`ux_search\`; ask \`ux_check\` whether a command is refused in the open project right now.

## Layout

- \`commands/<namespace>/<name>.md\` — one page per command (${docs.commands.length}). Start here before writing a \`show_me\` step.
- \`effects/<id>.md\` — one page per effect (${docs.effects.length}): what a control does to its own surface without a command.
- \`editors/<editor>.md\` — what each pane draws, by rule module and situation (${docs.editors.length}).
- \`situations/<module>.md\` — every situation of a rule module and which offers flip between them (${docs.situations.length}).
- \`interactions/<id>.md\` — one page per drag gesture a \`show_me\` step of kind \`gesture\` can name (${docs.interactions.length}).
- \`shortcuts.md\` — every key binding.

## Reading a command page

- **Drawn by** lists every control that runs the command, one row per control, with the situations it is drawn in. *Props known* are the props the control already carries at draw time; a step needs to supply only the rest. *Then* is what the click does after the command.
- **Refused when** lists every refusal a fixture produced, verbatim. That sentence is what a step's \`say\` should quote when the author will meet the refusal.
- **Reached after** lists the clicks that run this command as a later step.
- **Reaching it** says whether the sweep of a sample project found a control, whether a palette-only rule covers the command, and which shortcut or menu entry runs it. A command with no control still works in a tour: the app opens the command palette on it.

## Four step kinds

A \`show_me\` step is \`command\` (press a control), \`input\` (type into a box and commit it, naming the prop typed as \`supplies\`), \`select\` (pick a subject by its kind and id) or \`gesture\` (a drag, named by its interaction id).

## Ids are a fixture's

Every situation is a hand-written fixture. An id in a sentence, in *Props known*, or in a menu's \`when\` key (\`scene:sample\`, \`arrival:s1\`) belongs to that fixture, not to the open project. Take real ids from the workspace index.

## An effect is not a command

An effect (\`ui.publish\`, \`pane.view\`, …) names what a control does to its own surface. It cannot be a \`command\` step; a tour reaches it through the control, shortcut or menu entry its page lists.

## A search hit

A \`ux_search\` hit is one line of a page with the page's path in front. A table row's columns are positional; the page's header names them, so read the page when a hit's columns are unclear.
`;
}

/** Every page of the tree, keyed by its path under the root. */
export function render(docs: UxDocs): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set('README.md', renderReadme(docs));
  for (const page of [...docs.commands, ...docs.effects]) {
    pages.set(pagePath(page), renderPage(docs, page));
  }
  for (const home of docs.editors) pages.set(`editors/${home.id}.md`, renderEditor(home));
  for (const mod of docs.situations) {
    pages.set(`situations/${mod.module}.md`, renderSituations(mod));
  }
  for (const entry of docs.interactions) {
    pages.set(`interactions/${entry.id}.md`, renderInteraction(entry));
  }
  pages.set('shortcuts.md', renderShortcuts(docs.shortcuts));
  return pages;
}

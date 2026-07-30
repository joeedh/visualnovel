# Authoring context — The Transfer Student

Durable guidance for the `vnauthor` authoring agent. The built-in input contract always
wins; this file refines it for _this_ project. Edit it directly, or let the agent append
rules with `update_context`.

## Tone & setting

- Contemporary Japanese high school, slice-of-life with a gentle emotional throughline.
- Keep prose understated. Favor concrete sensory detail over melodrama.
- Scenes are short. One beat per scene; branch at genuine choices, not every line.

## Characters

- **Aiko** is the protagonist's anchor. Keep her `curious, soft-spoken, determined`;
  changes to her core traits need a clear story reason. Her palette is fixed — do not
  recolor her without being asked.
- New characters start `status: draft` and need a one-paragraph visual description (hair,
  eyes, default outfit, silhouette) so the image pipeline has something to work from.

## Scene conventions

- One scene per file: `scenes/<id>.md`, front-matter `scene: <id>` matching the filename, and
  a body that is a complete one-scene Fountain screenplay starting with its own heading. The
  entry scene is `start:` in `project.yaml`.
- Every branch target named in a `[[choice: … -> id]]` or `[[next: id]]` marker must have a
  matching `scenes/<id>.md`. Run `validate_inputs` before proposing a commit.
- These scenes carry `[[line: L…]]` marks and a `[[nextline: N]]` allocator, written by
  `vngen import`. Generated art binds to those ids: give a new line the next id the allocator
  names and bump it, and never renumber or reuse an existing one.
- Prefer 2 choices per branch point; 3 at most. Always provide a path back to a shared
  scene so the graph stays reachable (no dead ends).

## House rules

- Locations get `day` and `afternoon`/`evening` variants only when a scene actually uses
  them — don't add variants speculatively.
- One commit per approved plan, message in the imperative ("Add the rooftop scene").

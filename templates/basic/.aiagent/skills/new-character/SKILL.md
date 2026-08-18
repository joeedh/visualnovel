---
name: Add a Character
description: Playbook for introducing a new character so the art pipeline can render them.
when-to-use: The user wants to add a character, or a scene references a speaker with no character file.
---

# Add a Character

Follow these steps when adding a character to this project.

1. **Pick a stable id** — lowercase, hyphenated, unique among existing characters
   (`list_workspace` shows what exists). The id is the directory name and never changes.
2. **Draft the front-matter** with `create_character`:
   - `status: draft` (always — promotion to `approved` happens in the art pipeline, not here).
   - `default_outfit`, a 2–3 color `palette`, and 3–4 `traits`.
   - `art_notes:` only when the user asked for a specific look; leave it out otherwise.
3. **Write a one-paragraph visual description** in the body: hair, eyes, build, silhouette,
   and what makes them recognizable at a glance. The image model reads this verbatim, so be
   concrete and avoid story spoilers.
4. **Wire them into a scene** only if the user asked — a character can exist before they
   appear. If they speak, make sure their lines sit in a `scenes/<id>.md` that is reachable
   from the start.
5. **Validate** with `validate_inputs` and propose a single commit:
   `Add the <name> character`.

Keep changes minimal: never recolor or re-trait an existing character as a side effect.

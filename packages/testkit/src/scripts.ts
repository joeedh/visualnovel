/**
 * Named screenplay topologies. A test names the shape it needs — a fork, a rejoin, a dead
 * branch — instead of inlining Fountain, so the same four scripts back every fixture and a
 * change to one is visible everywhere it is used.
 */

/** Two scenes joined by a linear `[[next:]]`. The smallest runnable story. */
const linear = `INT. CLASSROOM - DAY

[[scene: arrival]]

Aiko sets her bag down by the window.

AIKO
It's quieter than I expected.

[[next: rooftop]]

EXT. ROOFTOP - EVENING

[[scene: rooftop]]

The city hums somewhere below.
`;

// Byte-identical to the SCRIPT constant `packages/export/src/tests/playable.test.ts` used
// before it moved here — that test's assertions are pinned to this exact text.
const branching = `INT. CLASSROOM - AFTERNOON

[[scene: arrival]]

The door slides open. Aiko steps in.

AIKO
Um... hello.

[[next: rooftop]]

EXT. ROOFTOP - EVENING

[[scene: rooftop]]

Aiko pushes through the door. Haruki leans on the fence.

AIKO
Sorry.

HARUKI
Most people don't come up here.

[[choice: Stay -> good_end]]
[[choice: Leave -> bad_end]]

INT. CLASSROOM - EVENING

[[scene: good_end]]

The light fades warmly.

INT. HALL - NIGHT

[[scene: bad_end]]

The hall is empty.
`;

/** A fork whose branches rejoin — exercises layout and reachability together. */
const diamond = `INT. CLASSROOM - DAY

[[scene: arrival]]

Aiko hesitates in the doorway.

[[choice: Speak up -> greet]]
[[choice: Stay quiet -> observe]]

INT. CLASSROOM - DAY

[[scene: greet]]

AIKO
Hello. I'm Aiko.

[[next: rooftop]]

INT. CLASSROOM - AFTERNOON

[[scene: observe]]

Aiko takes the seat by the window and says nothing.

[[next: rooftop]]

EXT. ROOFTOP - EVENING

[[scene: rooftop]]

HARUKI
You found the quiet place.
`;

/** A scene nothing points at — drives the `unreachable_scene` diagnostic. */
const orphan = `INT. CLASSROOM - DAY

[[scene: arrival]]

Aiko waves from the doorway.

[[next: rooftop]]

EXT. ROOFTOP - EVENING

[[scene: rooftop]]

The courtyard lights come on below.

INT. HALL - NIGHT

[[scene: forgotten]]

Nobody ever comes down here.
`;

export const SCRIPTS = { linear, branching, diamond, orphan } as const;

/** Name of a script in {@link SCRIPTS}. */
export type ScriptName = keyof typeof SCRIPTS;

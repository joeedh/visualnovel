# Verifying a Storylet Narrative at Trilogy Scale

<!-- toc -->

- [Goals and constraints](#goals-and-constraints)
- [What "robust" means](#what-robust-means)
- [The model](#the-model)
    - [State](#state)
    - [Storylets](#storylets)
    - [Which storylet fires is left open](#which-storylet-fires-is-left-open)
    - [Gameplay writes](#gameplay-writes)
    - [Modules](#modules)
- [Properties](#properties)
- [Why the whole game cannot be searched](#why-the-whole-game-cannot-be-searched)
- [Making it tractable](#making-it-tractable)
    - [Slicing](#slicing)
    - [Act boundaries and summaries](#act-boundaries-and-summaries)
    - [Partial-order reduction](#partial-order-reduction)
    - [Interval contracts](#interval-contracts)
    - [Loop acceleration](#loop-acceleration)
    - [Symmetry reduction](#symmetry-reduction)
    - [Incremental re-checking](#incremental-re-checking)
- [Time](#time)
    - [Levels](#levels)
    - [Semantic decisions](#semantic-decisions)
    - [Checks that time adds](#checks-that-time-adds)
- [Engines](#engines)
- [Keeping the solver and the runtime in agreement](#keeping-the-solver-and-the-runtime-in-agreement)
- [Language features and what they cost](#language-features-and-what-they-cost)
- [Sizing estimate](#sizing-estimate)
- [Story structures that test the solver](#story-structures-that-test-the-solver)
    - [A probe corpus](#a-probe-corpus)
- [Open questions](#open-questions)
- [Relation to this repository](#relation-to-this-repository)

<!-- tocstop -->

This is design research for a verification solver for a storylet-based narrative model. It
expands §2 of [`storylet-system.md`](storylet-system.md), which names Petri nets and SMT
solvers but leaves out the scale problem, the semantics, and the checks that matter most
to writers. It also covers content that depends on the passage of time, and the story
structures that would test the design hardest. Nothing here is built. The model may end up
in its own app rather than in VN Generator, so this document assumes nothing about the
current packages beyond the final section.

## Goals and constraints

These were set by the owner on 2026-10-26.

- **Target.** The model is for writing and storyboarding RPGs, and it should work for
  visual novels too. It must support narratives at least as complex as the Mass Effect
  trilogy, and ideally more complex.
- **The solver is required.** Checking for deadlocks, unreachable content and broken gates
  is part of the core product, not an optional add-on.
- **Qualities are integers.** Every continuous value (trust, fear, tension) is a bounded
  integer with a declared range. A value meant as -1.0…1.0 in tenths becomes -10…10. This
  makes the state space finite, so every property below is decidable.
- **The solver runs while people write.** An edit should re-check the properties it can
  affect in seconds. A full re-check can run as a batch job, but authors should not have
  to wait for one.

## What "robust" means

- **Sound.** A passing check holds for every playthrough the model allows, not only for
  the playthroughs that were sampled.
- **Every failure has a counterexample.** A failed check reports a concrete sequence of
  storylets and choices that reaches the bad state. Writers fix playthroughs, not
  formulas.
- **An exhausted budget is reported as unknown.** When a check runs out of time or memory
  it reports "unknown", with how far it got (states explored, depth reached). It never
  reports a pass.
- **The solver and the runtime share one semantics.** The solver proves properties of its
  model of the rules. If the model and the runtime evaluator disagree about clamping, the
  order effects apply in, or how a precondition is read, then the proof is about a
  different game. This is the failure that is easiest to miss, and
  [Keeping the solver and the runtime in agreement](#keeping-the-solver-and-the-runtime-in-agreement)
  covers it.

## The model

### State

- **Flags** are booleans. A flag is set-once by default: it goes from false to true and
  never back. A flag that can be cleared must be declared `resettable`. Set-once flags
  record history, and they keep the reachable state space small and ordered (see
  [Language features and what they cost](#language-features-and-what-they-cost)).
- **Qualities** are bounded integers. Each one declares a range and a starting value. An
  addition that would leave the range saturates at the bound. The saturation rule is
  defined once and shared by the solver and the runtime.
- **Derived values** are computed from flags and qualities and are never stored. A
  military strength total that sums the value of every allied faction recruited is a
  derived value. A solver can reason about a sum directly. It cannot do the same for a
  stored counter, which it would have to track step by step.
- **History** is implicit. Every storylet has a set-once `fired` flag. A repeatable
  storylet also has a fire count, capped at a declared maximum.
- **Tiers** are needed by a project with time loops or new-game-plus. Such a project
  declares two tiers of state. Persistent state is set-once across the whole project.
  Per-loop state is cleared in one step by a declared reset storylet, such as the end of a
  loop or the start of a new playthrough. The reset is the only way per-loop state is
  cleared, so per-loop flags stay set-once within a loop.
- **Time** is state as well, at one of the levels described in [Time](#time).

### Storylets

- A storylet has a guard (its precondition) and one or more choices. Each choice is a
  separate transition with its own effects. A storylet with no player choice has exactly
  one.
- An ending is a storylet declared `ending`. A playthrough is complete when an ending
  fires.
- A linked scene is a storylet whose guard is "the previous scene fired". The model
  therefore includes ordinary branching, and a project can mix scripted sequences with
  state-gated content. Checking a linear stretch costs almost nothing.
- A **beat group** names several storylets as alternative versions of the same story beat.
  One example is a confrontation that plays with whichever companion survived, or alone
  when none did. The group declares whether at least one alternative must be available
  (coverage), at most one (exclusivity), or exactly one.

### Which storylet fires is left open

The checker treats the choice of storylet as unconstrained. Any enabled storylet may fire
next, so results hold whatever the runtime picker (§3 of the earlier doc) does. As a
consequence, "reachable" means reachable by some picker. Content the trained picker never
actually chooses can still pass a reachability check. Probabilistic questions ("reachable
but unlikely") are out of scope.

Forced storylets are the one exception, decided on 2026-10-26. While a storylet declared
`forced` is enabled, only forced storylets may fire. A scheduled event uses this rule to
happen when it is due, ahead of optional content. The rule is part of the shared
semantics, because without it the solver would explore playthroughs in which the event is
postponed, and the game cannot produce those. What happens when two forced storylets are
enabled at once is still open (see [Open questions](#open-questions)).

### Gameplay writes

RPG gameplay systems such as combat, the economy and inventory also write narrative state.
Each such write is modelled as an environment transition with a declared set of outcomes.
A boss fight is a transition that may set `boss_defeated` or `party_wiped`, and
`ally_count` may drop by 0 to 2. The solver assumes any declared outcome can happen. A
gameplay write that is not declared is a compile error, because it would be a state change
the solver never considers.

### Modules

A module is a quest, a mission or a hub. It declares the following:

- the variables it owns, which only its own storylets may write
- the variables it reads from other modules
- the variables it exports for other modules to read

The compiler rejects an access to a variable that was not declared. A sketch, with
invented names:

```yaml
module: harbor_strike
owns:
    flags: [strike_called, dock_burned, oren_arrested]
    qualities:
        dockworker_trust: { range: [-5, 5], start: 0 }
reads: [act1.vel_alive, act1.vel_loyal]
exports: [dock_burned, dockworker_trust]
storylets:
    - id: union_hall_meeting
      when: { all: [strike_called], none: [oren_arrested] }
      choices:
          - id: back_the_strike
            set: [dock_burned]
            add: { dockworker_trust: 2 }
          - id: broker_a_deal
            add: { dockworker_trust: -1 }
beats:
    - id: harbor_confrontation
      alternatives: [confront_with_vel, confront_with_oren, confront_alone]
      require: exactly_one
```

An act is an ordered group of modules. An act boundary declares which variables carry
forward into the next act. A game boundary in a trilogy, where a save is imported into the
next game, is an act boundary whose carried variables make up the import format.

## Properties

| Check                | What it asserts                                                                                                | Kind                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Unsatisfiable guard  | Some state satisfies the storylet's guard                                                                      | per storylet, no search        |
| Orphan               | Some reachable state enables the storylet                                                                      | reachability                   |
| Deadlock             | Every reachable state is an ending or enables some storylet                                                    | invariant                      |
| Trap                 | From every reachable state, some ending is still reachable                                                     | forward and backward search    |
| Gate                 | No playthrough fires storylet C before storylet B                                                              | invariant over history flags   |
| Beat coverage        | Whenever a beat is due, at least one alternative is enabled                                                    | invariant                      |
| Beat exclusivity     | Whenever a beat is due, at most one alternative is enabled                                                     | invariant                      |
| Saturation           | No effect pushes a quality past its range (a warning, since saturation is defined)                             | invariant                      |
| Variant count        | The number of distinct entry contexts for each storylet (a report, not pass/fail)                              | projection of reachable states |
| Point of no return   | The transitions after which a storylet can no longer be reached (a report)                                     | backward search                |
| Progress             | In a project with loops, every reachable state can lead to an ending or to new persistent state                | forward and backward search    |
| Timeline consistency | A fact shown in one scene does not contradict the story-time state of a scene the player may already have seen | invariant over history flags   |
| Impact of an edit    | The difference between the reachable sets before and after an edit                                             | reachability, run twice        |

Some checks need more explanation than the table gives, and survivor dependency is covered
here although it has no row.

- **Trap** is the check [`storylet-system.md`](storylet-system.md) leaves out. A hub whose
  storylets keep enabling each other never deadlocks, but a player can circle it forever
  with no route to an ending. A trap is not an invariant, because it says something about
  every possible future of a state. That decides which engines can check it (see
  [Engines](#engines)).
- **Gate** adds history flags and checks the invariant `fired_C → fired_B`. A
  counterexample is usually a second storylet that sets the gated flag by another route,
  sometimes around a loop the author did not notice.
- **Survivor dependency** needs no check of its own. If the main line depends on a
  character who may be dead, then a state where that character is dead is a deadlock or a
  trap, and those checks find it. The difference is in how a failure is reported: the
  solver groups counterexamples by the carried facts that cause them ("fails whenever
  `vel_alive` is false"). That grouping is what a writer needs in order to add a stand-in.
  Beat coverage is the check that confirms the stand-in works.
- **Variant count** is for storyboarding. For each storylet, the solver takes the
  reachable states at the moment the storylet fires and keeps only the variables the
  storylet's content refers to, such as which companion is present and how loyal they are.
  The number of distinct results is the number of versions that have to be written,
  boarded and voiced. A report can show that a scene has 14 reachable variants, 9 of which
  differ only in one line. The same projection gives the factual entry context for the
  author dossier in §4 of the earlier doc.
- **Point of no return** uses the same backward search as the trap check. For each
  storylet, the solver computes the set of states from which the storylet is still
  reachable. A transition that leaves that set is a point of no return for that storylet.
  The report lists those transitions, so a writer can confirm that each one is intended,
  and the game can warn the player before one is taken. Clocks are not needed for this. A
  final mission that locks out the remaining side content is a point of no return.
- **Progress** replaces the trap check in a project with loops. A loop is meant to repeat,
  so a state that never reaches an ending is not by itself a fault. The fault is a state
  from which the player can neither reach an ending nor set any persistent flag that is
  not already set. Persistent flags are set-once and finite, so a project that passes this
  check always lets the player make progress.
- **Timeline consistency** applies when the player sees events out of chronological order.
  Each storylet declares when it happens in story time, separately from when the player
  sees it, and it declares the facts it shows as true at that time. The check looks for a
  playthrough that shows two conflicting facts about the same story time. One example is a
  scene set on day 3 that shows a character alive, after the player has already seen a
  scene establishing that the character died on day 2.
- **Impact of an edit** turns §2.2 of the earlier doc into a concrete diff. The edit
  report lists storylets that became unreachable, new deadlocks and traps, beats that lost
  coverage, and assets referenced only by unreachable storylets.

## Why the whole game cannot be searched

The trilogy's save files carry plot tables with thousands of booleans, plus hundreds of
integer values. Those counts are approximate and have not been checked. Even 2,000
set-once flags allow 2²⁰⁰⁰ states in principle. Explicit-state search, BDDs and IC3 all
fail on a single model of that size.

The cost comes mostly from independent content being combined. Suppose an act has 30 side
quests, and each quest can be in about 10 states during the act. The act as a whole then
has about 10³⁰ combinations. Almost every check, however, concerns one or two quests.
Whether the harbor quest can deadlock depends on the harbor quest's 10 states and the few
facts it reads, not on the other 29 quests. The techniques below make the solver look only
at the part of the game a check depends on.

## Making it tractable

### Slicing

To check a property, the solver collects the variables the property mentions. It adds
every storylet that writes one of those variables, then every variable those storylets'
guards read, and repeats until nothing new is added. Anything outside the resulting slice
cannot affect the property and is removed. Hardware verification calls this
cone-of-influence reduction.

Module declarations make slicing fast and exact. The solver can first take the slice at
module granularity, using the declared reads and exports, and only then refine it variable
by variable inside the modules that remain. Without declarations, slicing has to infer
data flow from every guard and effect in the game, and one careless write can pull a large
part of the game into every slice.

Two kinds of check have large slices by nature. An ending often reads most of the carried
state, and so does a derived total over many factions. These go to the symbolic engines.

### Act boundaries and summaries

Each act is checked on its own. The solver computes the set of states in which the act can
end, keeping only the variables that carry forward, and uses that set as the next act's
set of starting states. For a trilogy, game 1's possible exit states are game 2's possible
entry states.

A boundary set is far too large to list state by state. Twelve companions who may each be
dead already give 4,096 combinations. Boundary sets are therefore held symbolically, as
BDDs. A BDD's size depends on how the variables are correlated, not on how many states the
set contains. Decisions that are independent of each other cost little, even when there
are dozens of them. Correlated facts cost more, such as a companion's loyalty that is only
meaningful while they are alive, or a sum over many weighted flags.

An act may also declare an assumed entry set, which works as a contract. The act can then
be checked before the acts that lead into it exist. The solver later checks that the
upstream exit set is contained in the assumed entry set. This lets separate teams work on
separate acts. It also covers a game started without an imported save, whose entry set is
one default state.

### Partial-order reduction

Two storylets that touch disjoint variables reach the same state whichever fires first.
Partial-order reduction explores one order instead of both. Storylet content is loosely
coupled by design, so the saving is large. It applies inside the explicit-state engine.

### Interval contracts

A quality shared by many modules, such as a faction's reputation, puts every module that
reads it into every slice that mentions it. An interval contract prevents this. Each
module that writes the shared quality declares a range for its net effect on it, for
example "this quest changes Legion reputation by -3 to +2". When the solver checks another
module, it replaces the contracted module with an arbitrary change inside the declared
range. It checks separately that each module stays inside its own contract.

The replacement allows every change the real module can make, plus some it cannot, so a
pass is sound. A failure may come from a change the real module never makes, so the solver
replays a failing counterexample against the real module before reporting it. A failure
that does not replay means the contract is too loose for that check.

### Loop acceleration

A repeatable storylet that adds 1 to a quality, with nothing else in its loop, reaches
every value from its starting point up to the cap. The solver computes that set in one
step instead of exploring each repetition. Grinding a quality to a threshold over 300
repeats then costs the same as one repeat. The technique applies to any loop whose effect
on its variables is a fixed addition.

### Symmetry reduction

A storylet quantified over a cast ("any companion with the coward trait") is expanded once
per cast member, so the size of the cast multiplies the state. Cast members that are
interchangeable for a check, because they hold the same role and traits, produce states
that differ only by a permutation of names. Symmetry reduction keeps one representative of
each such group. A generated cast must declare a maximum size, because an unbounded cast
makes the state space infinite.

### Incremental re-checking

Each check result is cached under a hash of its slice: the storylets, declarations and
boundary assumptions it was computed from. After an edit, only checks whose slice hash
changed are re-run. With module declarations, rewriting one storylet usually invalidates a
handful of checks rather than the whole game. This is what makes it practical to run the
solver in the editor.

## Time

Time systems form a ladder. Each level adds a capability and costs more to check. A
project should use the lowest level that expresses its design, and different modules may
use different levels.

### Levels

1. **Progression phases.** Time is a small enumeration that only specific storylets
   advance, such as "before the coup" and "after the coup". Mass Effect mostly works this
   way. ME2 also has a time dependency of this kind: after the crew is abducted, each
   further mission the player takes before the final mission means more of the crew die.
   That is a small countdown driven by missions rather than by a clock. Phases cost almost
   nothing.
2. **Timers.** An event starts a countdown, and a storylet fires when the countdown
   reaches zero ("three days after you betray the guild, assassins arrive").
   Timed-automata theory, the basis of the UPPAAL model checker, supplies the main
   technique here. Once a timer exceeds the largest constant that any guard compares it
   with, its exact value no longer affects any guard. The solver therefore caps the timer
   at that constant plus one. With integer time the cap is exact rather than an
   approximation. Elapsed time should be stored as timers that count from events, not as
   absolute timestamps, because each absolute timestamp multiplies the state by the length
   of the campaign.
3. **A global clock with windows and deadlines.** A storylet may be available only inside
   a window (`day 10–14`), and a scheduled event fires at a set time whatever the player
   is doing. A scheduled event is a forced storylet (see
   [Which storylet fires is left open](#which-storylet-fires-is-left-open)). The clock is
   bounded by the campaign's length. Timed-automata tools represent sets of clock values
   as difference constraints (zones) rather than listing each value, and the symbolic
   engines can use the same representation.
4. **World processes on schedules.** A plague that spreads through districts, or NPCs
   following daily routines, advances with the clock whether or not the player is
   involved. Each process is a module whose transitions are driven by time, and it
   interacts with the player's story only through shared variables. Partial-order
   reduction applies between processes that do not interact.
5. **Time as a shared budget.** In a calendar game, a day spent with one character is a
   day not spent with another, so time couples every module and slicing stops working. The
   compositional answer is to summarise each module by how much time it takes (a range),
   the windows it must run in, and its prerequisites. Whether every required module can
   fit then becomes a scheduling problem, which SMT solves over the summaries without a
   search over states. A summary is a contract like an interval contract: the solver
   checks each module against its summary, and replays a failing schedule against the real
   modules before reporting it.

### Semantic decisions

- **Forced storylets take priority.** This was decided on 2026-10-26 and is described in
  [Which storylet fires is left open](#which-storylet-fires-is-left-open).
- **What advances time** is open. Time could advance by a cost declared on each storylet,
  by an explicit wait or rest action, or by both. An explicit wait matters to the checks,
  because it lets the player waste time on purpose, and that is what makes a deadline
  missable.
- **Whether the clock carries across act boundaries** is open. A clock that carries
  becomes part of every boundary set.
- **Real-world time** (content that unlocks on calendar dates, or timers that run while
  the game is closed) is out of scope.

### Checks that time adds

- **Missable content.** Each storylet that can be missed is listed with the latest point
  at which it can still be reached. This is the point-of-no-return report restricted to
  points that depend on the clock.
- **Deadline traps.** A required beat whose window the player can waste. The check fails
  unless the author has declared a failure ending or a fallback beat for that case.
- **Schedule conflicts.** Two required events that can come due at the same time.
- **Firing-time range.** For each storylet, the earliest and latest time at which it can
  fire, and the times of day and seasons it can fire in. For storyboarding, this gives the
  number of background and lighting variants a scene needs. It is the variant count
  applied to time.

## Engines

The solver uses several engines. Each check is routed to the engine that suits it,
according to its kind and its estimated slice size.

- **Static checks (SMT, for example Z3).** These cover unsatisfiable guards, quality
  ranges and duplicate storylets. They need no search and can run on every keystroke.
- **Explicit-state search (the default inside a slice).** This is a breadth-first search
  over concrete states with a hash set of visited states, in the style of TLC or SPIN.
    - It executes the runtime's own transition function, so it cannot disagree with the
      game.
    - Breadth-first order finds the shortest counterexample, which is the easiest to read.
    - It finds traps by keeping the explored state graph and searching backwards from the
      endings. Every reachable state the backward search does not reach is in a trap, and
      the forward path to it is the counterexample.
    - It applies partial-order reduction.
- **BDDs (for boundary sets and mid-sized slices).** These hold act exit sets and survivor
  combinations, and they can check traps on slices too large for explicit search.
- **SAT/SMT model checking (for invariants over large slices and derived totals).**
  IC3/PDR is the current standard method for proving invariants over very large state
  spaces. Z3's Spacer engine runs it directly over integer arithmetic. It covers deadlock,
  gate and beat checks, and threshold questions over derived totals, which BDDs and
  explicit search handle badly. It does not handle traps. Plain SMT, without a model
  checker around it, also solves the scheduling problem for time budgets.

Every result records how it was obtained: the slice, the boundary assumptions, the engine,
any depth bound, and the budget it used. An "unknown" result can therefore be traced to
the module and the boundary that caused it.

## Keeping the solver and the runtime in agreement

- The transition semantics (guard evaluation, the order effects apply in, saturation,
  repeat caps, environment outcomes) is defined once, in one intermediate form compiled
  from the storylet source.
- The runtime and the explicit-state engine both execute that form. They use the same
  code, not two implementations of the same rules.
- The symbolic encoders (BDD and SMT) are generated from the same form. They are tested
  differentially: random states are sampled, and for each state the successor set the
  symbolic encoding allows is compared with the successor set the explicit engine
  computes. A mismatch is an encoder bug, and it shows up as a test failure rather than as
  a false proof.
- Gameplay writes go through declared environment transitions (see
  [Gameplay writes](#gameplay-writes)). Engine code that writes narrative state directly
  is rejected, because the solver cannot see it.

## Language features and what they cost

Every language feature changes what the solver has to do. Each should be added
deliberately.

| Feature                                  | Effect on the solver                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Set-once flags with only positive tests  | Whether a storylet can ever fire becomes a fixed-point computation in polynomial time, close to Horn-SAT. Very cheap.    |
| Negative tests (`none`)                  | Loses the polynomial shortcut. Needs a real search, but set-once flags still keep the reachable states ordered.          |
| Resettable flags                         | Loses the ordering. States can recur, and traps become possible.                                                         |
| Qualities                                | Cost multiplies by the range size. A range of 21 values is fine. A range of 0…1000 belongs in a derived value or in SMT. |
| Derived totals                           | Cheap for SMT, expensive for explicit search. Route their checks to SMT.                                                 |
| Repeatable storylets                     | Need a cap. Uncapped repetition makes the fire count unbounded and the state space infinite.                             |
| Unbounded counters (days elapsed)        | Not allowed. Declare a maximum, or use one of the levels in [Time](#time).                                               |
| Undeclared cross-module reads or writes  | Not allowed. They make slicing inexact and break incremental re-checking.                                                |
| Shared qualities written by many modules | Every reader joins every slice. Needs interval contracts.                                                                |
| Progression phases                       | Almost free.                                                                                                             |
| Timers                                   | Cheap once capped at the largest constant they are compared with.                                                        |
| Absolute timestamps                      | Each multiplies the state by the campaign length. Use timers instead.                                                    |
| A global clock                           | Cost multiplies by the campaign length, and every module that reads the clock joins every slice that mentions it.        |
| Time as a shared budget                  | Needs per-module time summaries and a scheduling check. Without them, nothing in the project can be checked separately.  |
| Forced storylets                         | Cheap, but the priority rule must be in the shared semantics.                                                            |
| Per-loop state with a reset              | Allowed only through the declared reset. Needs the progress check in place of the trap check.                            |
| Storylets quantified over a cast         | Cost multiplies by cast size. Needs a declared maximum, and symmetry reduction to stay tractable.                        |

## Sizing estimate

These numbers are estimates and have not been measured. The first prototype should measure
them.

The estimate uses a trilogy-shaped project: 3 games of 4 acts each, about 15 modules per
act, 10 to 40 flags and 1 to 3 qualities per module, and quality ranges of at most 21
values. About 100 variables carry from one game to the next: 12 survivors, 12 loyalty
flags, about 60 major decisions, and the inputs to one derived total.

- **A typical module check.** The slice holds 1 to 4 modules. With set-once flags and
  partial-order reduction, that is roughly 10² to 10⁶ states, which explicit search covers
  in milliseconds to seconds.
- **A boundary set.** It allows up to about 2¹⁰⁰ states. Its BDD stays small when most
  decisions are independent, probably thousands of nodes. The correlated facts drive the
  size, so the derived total is the term to watch.
- **An ending or a total-threshold check.** The slice holds most of the carried state.
  These go to SMT/IC3 and are run as batch jobs, not on every edit.
- **Incremental cost.** Editing one storylet re-runs the checks for its own module plus
  the checks that read its exports. That should be a few explicit-state checks, well under
  the seconds budget from [Goals and constraints](#goals-and-constraints).

The estimate fails if modules turn out to be much more coupled than assumed, for example a
reputation quality read by every module. That would make most slices span most of an act.
Interval contracts and time summaries are the planned answer to that coupling, but how
tight the contracts can be made in practice is unknown. Measuring the coupling in a real
outline is the most useful early experiment.

## Story structures that test the solver

Mass Effect branches on major plot decisions, on which characters survive and how loyal
they are, and on Paragon and Renegade. It is a hub game: missions are mostly independent,
and they affect each other through a few carried facts. In ME1 and ME2, Paragon and
Renegade were two counters that only increased, and persuasion options compared them with
thresholds. That is the cheapest kind of quality there is. The trilogy therefore tests
size, not coupling. A solver that handles it could still fail on a much smaller game with
a different structure.

Each structure below breaks a specific technique the solver relies on.

| Structure                           | Examples                                            | What it breaks                                                                                        | What the solver needs                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub of independent missions         | Mass Effect                                         | Nothing. This is the baseline, and it tests size.                                                     | Slicing, boundary sets, survivor grouping, beat coverage                                                                                                                            |
| Hub whose missions depend on order  | Alpha Protocol                                      | Missions read and write each other's state, so slices merge and partial-order reduction stops helping | Contracts stating which exports each module can set and in which combinations, checked like interval contracts                                                                      |
| Faction reputation in an open world | Fallout: New Vegas                                  | One shared quality is read by every module                                                            | [Interval contracts](#interval-contracts)                                                                                                                                           |
| Split at the act level              | The Witcher 2's two middle acts                     | Little by itself. It tests whether the act after the split handles both boundary sets                 | Merged boundary sets, and beat coverage at the merge                                                                                                                                |
| Investigation and knowledge         | Disco Elysium, Outer Wilds, Return of the Obra Dinn | Hundreds of clue flags that can be found in any order                                                 | The fixed-point shortcut for positive tests. A missing clue shows up as a trap. A scene that must not reveal a fact early needs a negative test, which is where the cost comes from |
| Time loops                          | Majora's Mask, Outer Wilds, Hades                   | World state is reset in bulk, and repetition is intended                                              | Two tiers of state and the progress check                                                                                                                                           |
| Routes unlocked across playthroughs | Fate/stay night, Zero Escape                        | State survives a new game                                                                             | The same two-tier model, with the new playthrough as the reset                                                                                                                      |
| Calendar or time budget             | Persona, 80 Days                                    | Time is read by every module                                                                          | [Time as a shared budget](#levels)                                                                                                                                                  |
| Simultaneous world processes        | Pathologic                                          | Processes advance whatever the player does, and many of them interleave                               | World processes as modules, with partial-order reduction between them                                                                                                               |
| A fixed timeline shown out of order | 13 Sentinels: Aegis Rim                             | Story order and play order differ                                                                     | The timeline consistency check                                                                                                                                                      |
| Procedural casting                  | Wildermyth, Crusader Kings                          | Storylets range over generated characters, so the cast is unbounded                                   | A declared cast maximum and [symmetry reduction](#symmetry-reduction)                                                                                                               |
| Resource grind                      | Fallen London, Sunless Sea                          | Quality ranges are wide and storylets repeat                                                          | [Loop acceleration](#loop-acceleration), and SMT for the threshold checks                                                                                                           |

### A probe corpus

The solver needs a benchmark suite before it needs real projects. The suite is one
synthetic project per row of the table, each sized beyond Mass Effect along the axis that
row stresses. Three probes come first, because each one attacks a technique the rest of
the design depends on.

1. **A hub whose missions depend on order** attacks slicing.
2. **A calendar** attacks the independence of modules through shared time.
3. **A time loop** attacks set-once flags, which most of the cheap checks rely on.

Each probe records the state counts, slice sizes and run times of every check, so the
[sizing estimate](#sizing-estimate) is replaced by measurements.

## Open questions

- **Building on existing tools.** One option is a custom explicit-state engine plus Z3
  (MIT-licensed, with an official WebAssembly build on npm) and a BDD library. The other
  is driving an existing model checker such as nuXmv or TLC. The licences need checking
  before this is decided; nuXmv's is believed to restrict commercial use.
- **The storylet language's syntax.** The YAML above is a sketch. The checker depends on
  the semantics in [The model](#the-model), not on the syntax.
- **How picker weights relate to the checks.** A storylet the picker almost never chooses
  passes every check. A probabilistic report would need probabilistic model checking,
  which is out of scope here.
- **Two forced storylets enabled at once.** One option is a declared priority order. The
  other is to let either fire and have the schedule-conflict check report the case. The
  shared semantics must pick one.
- **What advances time, and whether the clock carries across acts.** See
  [Semantic decisions](#semantic-decisions).
- **How tight interval contracts and time summaries can be.** A loose contract makes the
  solver report failures that do not replay. The probe corpus should measure how often
  that happens.
- **Standalone app or part of VN Generator.** Undecided. Nothing above depends on the
  answer.

## Relation to this repository

- The current story model has no runtime state. Branches are explicit links in the
  screenplay, and [`../reference/playable-format.md`](../reference/playable-format.md) has
  no flags or conditions. Reachability, orphan and dead-end checks there are plain graph
  searches over a known graph, and none of this solver is needed for it.
- Module ownership declarations work like a mutating command's `affects` declaration in
  [`../reference/command-system.md`](../reference/command-system.md): an upper bound on
  what may be written, which the system enforces.
- Caching check results under a hash of their slice follows the same idea as the
  content-addressed task graph in
  [`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md). A result is
  reused while its inputs are unchanged, and it is recomputed when they change.

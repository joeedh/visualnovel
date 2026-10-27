# Architecture Specification: Verified Systemic Narrative Engine (SNE)

## Executive Summary

Traditional AAA interactive narrative pipelines rely on hardcoded branching trees, bespoke motion capture staging, and manual quality assurance. This model collapses under the weight of high-permutation storytelling: scaling narrative branches results in exponential asset costs, narrative deadlocks, and severe cognitive strain on writing teams.

The Systemic Narrative Engine (SNE) is an alternative production architecture. It unifies:
1. A **Quality-Based Storylet Database** for decoupled content presentation.
2. A **Formal Graph Model Checker** for compile-time deadlock verification.
3. A **Local, Non-Autoregressive Decision Model** for real-time dramatic routing and pacing.
4. An **Automated Persona and Trajectory Synthesis Tool** to ground human writers without prescribing dialogue.
5. An **Offline Reinforcement Learning Loop** utilizing playtest telemetry to optimize narrative rhythm.

```
                      +---------------------------------------+
                      |       Authoring Suite (IDE)          |
                      |  - Node Editor & Storylet Graph       |
                      |  - Graph Inversion & Dossier Tool     |
                      +---------------------------------------+
                                          |
                        [Graph Check & Node Ingestion]
                                          v
                      +---------------------------------------+
                      |      Formal Verification Engine       |
                      |  - Petri Net / SMT Reachability       |
                      |  - Deadlock & Orphan Detection        |
                      +---------------------------------------+
                                          |
                      +-------------------+-------------------+
                      |                                       |
                      v                                       v
        +---------------------------+           +---------------------------+
        |   Offline Alignment Pass  |           |      Runtime Engine       |
        |  - Synthetic Edge Mining  |           |  - Tag/Flag Blackboard    |
        |  - Human Active Learning  |           |  - Ultra-fast Evaluator   |
        |  - DPO & Telemetry Tune   |           |  - Dramatic Scheduler     |
        +---------------------------+           +---------------------------+
                      |                                       |
                      +-------------------+-------------------+
                                          v
                      +---------------------------------------+
                      |         Human-Authored Assets         |
                      |  - Cinematic Sequences & Cutscenes   |
                      |  - Modular Audio & Dynamic VO Barks   |
                      +---------------------------------------+
```

---

## 1. Core Data Model & Execution Graph

The engine transitions away from scene-to-scene linked scripts. The foundational structural unit is the **Storylet**, managed via a global blackboard.

### 1.1 Structural Primitives

* **Tags (Ontological Labels):** Static or transient categorical descriptors bound to entities (e.g., `[PARAGON]`, `[WOUNDED]`, `[SPECTRE]`, `[HOSTILE]`).
* **Flags (Discrete Ledger):** Boolean historical records marking completed events (e.g., `omega_reactor_purged: true`, `aria_dead: true`).
* **Qualities (Continuous Vectors):** Bounded scalar variables representing emotional, political, or systemic states:
  * *Relational Vectors:* Trust, Fear, Complicity, ideological alignment $\in [-1.0, 1.0]$.
  * *Macro Pacing:* Dramatic tension $T \in [1, 5]$, regional alert level, combat fatigue.

### 1.2 Storylet Specification

Each storylet is a self-contained content node defined by a strict schema:

```yaml
storylet_id: "omega_balcony_confrontation_petrovsky_01"
directorial_status: LOCKED # LOCKED | PROVISIONAL | PROPOSED
dramatic_tension: 4
preconditions:
  all_of:
    - flag: "aria_dead == true"
    - flag: "petrovsky_executed == false"
    - quality: "omega_military_control >= 0.7"
  none_of:
    - tag: "shepard_incapacitated"
mutations:
  set_flags:
    - "garrus_omega_disillusionment: true"
  delta_qualities:
    - "garrus_trust: -0.2"
    - "renegade_standing: +15"
assets:
  cinematic_template: "cin_balcony_confrontation_v02"
  dialogue_manifest: "dl_omega_aftermath_shep_petrovsky"
```

---

## 2. Compile-Time Verification & Mutation Analysis

Rather than relying on manual QA to find broken narrative states, the engine compiles the storylet database into a formal state-space model (utilizing Petri Net reachability and SAT/SMT constraint solvers).

### 2.1 Graph Invariant Checking

At compile time, the verification tool runs continuous automated sweeps:
* **Deadlock Detection:** Proves that from every reachable world-state configuration, at least one downstream storylet satisfies all preconditions until an authorized campaign terminal state is reached.
* **Orphan Detection:** Identifies un-triggerable nodes whose preconditions contain mutually exclusive or mathematically impossible state requirements.
* **Prerequisite Validation:** Confirms that critical plot gates (e.g., Crucible construction thresholds) cannot be bypassed through circular state transitions.

### 2.2 Patch Analysis on Narrative Mutations

When a narrative designer introduces a major systemic mutation late in production (e.g., permitting the player to kill Aria T'Loak and seize Omega directly):

1. **State Injection:** The engine injects `aria_dead: true` into the target node.
2. **Impact Boundary Mapping:** The reachability solver traces downstream dependencies, isolating every node that requires `aria_alive == true`.
3. **Deficit Ledger Generation:** The solver produces an exact list of broken dependencies:
   * Orphaned dialogue trees in downstream hubs.
   * Broken asset pointers (e.g., missing war asset calculations).
   * Unresolved companion relationship arcs.

---

## 3. Runtime Decision Model & Dynamic Scheduling

Dynamic orchestration replaces brute-force `if/else` scripting. Content is selected in real time by a specialized, local, non-autoregressive decision model.

```
[ Global Blackboard: State, History, Recent Telemetry ]
                           │
                           ▼
  ┌──────────────────────────────────────────────────┐
  │ Local Non-Autoregressive Decision Model (~100MB) │
  │ - Input: Dense State Vector + Candidate Embeddings│
  │ - Latency: <15ms per evaluation                  │
  │ - Output: Calibrated Logits over Storylet IDs    │
  └──────────────────────────────────────────────────┘
                           │
                           ▼
    [ Highest-Scoring Valid Candidate Selected ]
                           │
                           ▼
  [ Deterministic Execution: Load Mocap, VO, Camera ]
```

### 3.1 Model Architecture

* **Type:** Dense cross-encoder/multi-head classification network running locally on CPU or compute shaders (memory footprint $< 100\text{ MB}$, inference latency $< 15\text{ ms}$).
* **Determinism & Bounds:** The model never generates text, tokens, or audio. It evaluates candidate storylet IDs that have already cleared the symbolic precondition filter, outputting calibrated probabilities based on dramatic fit.
* **Pacing Clocks (Dramatic Scheduler):** The model enforces tension rhythms. Following a Level 5 dramatic spike, the scheduler applies negative weights to high-intensity candidates, forcing the selection of lower-intensity decompression scenes (camp dialogue, logistics, atmospheric exploration).

### 3.2 Telemetry-Driven Reinforcement Learning

During internal playtesting, telemetry logs are converted into an offline reinforcement learning dataset.

```
Playtest Trajectory (s, a, r, s')
  ├── Implicit Signals: Line Skips (<200ms), Save-Scums, Session Length
  └── Reward Calculation: R = w1(ListenRatio) - w2(SkipRate) - w3(SaveScumDelta)
```

* **Offline Policy Optimization:** Algorithms like Implicit Q-Learning (IQL) or Direct Preference Optimization (DPO) refine the decision model's candidate scoring based on empirical play patterns.
* **KL Regularization:** A strict Kullback-Leibler divergence penalty against the lead writer's baseline model prevents the policy from degenerating into constant action or comedy beats:
  $$\mathcal{L}(\theta) = \mathcal{L}_{\text{DPO}}(\theta) + \beta \, \mathbb{D}_{\text{KL}}\left(\pi_\theta(a \mid s) \parallel \pi_{\text{narrative\_ref}}(a \mid s)\right)$$

---

## 4. Authoring Suite: Persona Inversion & Trajectory Distillation

To solve the cognitive load problem where writers must juggle dozens of divergent player trajectories, the authoring environment integrates an automated state inversion engine backed by a fine-tuned local language model (4B to 8B parameters).

### 4.1 Upstream Trajectory Synthesis

When an author selects a node to write, the system executes a bounded reverse random walk (depth $N$) across valid entry edges. The local model distills this symbolic path into an objective narrative dossier.

```
[ Author Opens Node ] ──> [ Reverse Graph Walk ] ──> [ State & Flag Extraction ]
                                                              │
                                                              ▼
                                                   [ Local Inversion LLM ]
                                                              │
                                                              ▼
                                                 [ Read-Only Prose Dossier ]
```

### 4.2 Non-Prescriptive Dossier Specification

The inversion model is aligned to function as a factual briefing tool. It is strictly penalized for offering writing advice, dialogue suggestions, or moral commentary. It outputs:
* **Upstream Invariants:** Chronological recap of events that must have occurred to reach this node.
* **Production Clearances:** Real-time visibility into the directorial stability of previous beats (`LOCKED`, `PROVISIONAL`, `PROPOSED`).
* **Persona Parameter Envelope:** The psychological and emotional boundaries of the protagonist entering the scene.

#### Sample Node Dossier

```text
================================================================================
TRAJECTORY SUMMARY: Node [Omega_Aftermath_Balcony_04]
Preconditions: aria_dead == true, omega_ruler == Shepard, garrus_present == true
Directorial Stability: 2 Locked Dependencies, 1 Provisional Dependency
================================================================================

UPSTREAM EVENTS (CHRONOLOGICAL):

1. [LOCKED - Approved 2026-09-14]
   Shepard executed Aria T'Loak during the Afterlife perimeter breach. 
   Combat log: Aria initiated hostiles; Shepard terminated via sidearm. 
   Witnesses: Oleg Petrovsky, Bray, surviving Talon squad members.

2. [PROVISIONAL - Under Review in Systems/Narrative Hub Pass]
   Station life support was vented through the lower habitation sectors 
   to suppress Cerberus shock units (Casualties: ~3,400 civilians).
   * Note: Engineering bypass branch under active review. 
     Do not anchor long-form dialogue on specific casualty metrics.

3. [LOCKED - Approved 2026-08-28]
   Oleg Petrovsky was spared at the central core, accepting administrative 
   governance of Omega under Alliance military oversight.

CHARACTER DISPOSITION (BOUNDS):
- Morality Profile: Pragmatic/Utilitarian (Renegade Index: 0.82)
- Emotional Posture: Acute combat fatigue; immediate administrative focus.
- Relational Dynamics: 
  * Garrus Vakarian: High respect, high ethical tension (Trust: 0.45, Complicity: 0.70).
  * Alliance Command: Estranged/Transactional.
================================================================================
```

---

## 5. Structural Comparison

| Production Metric | Traditional AAA Branching | Systemic Narrative Engine (SNE) |
| :--- | :--- | :--- |
| **Data Architecture** | Hardcoded branching trees | Relational Storylet Blackboard |
| **Logic Verification** | Manual playtesting & scripted assertions | Formal SMT/Petri Net Model Checking |
| **Pacing Control** | Hardcoded structural bottlenecks | Dynamic Scheduling via Local Decision Model |
| **Refactoring Cost** | Exponential (full script rewrite required) | Localized (re-link state tags, patch isolated gaps) |
| **Cognitive Overhead** | High (writers track complex state tables) | Low (tool converts state bounds to factual dossiers) |
| **Runtime Efficiency** | Linear script execution | Low-latency state-matching ($< 15\text{ ms}$) |

---

## 6. Implementation Roadmap

### Phase 1: Core Framework & Schema Standardization
* Implement the core storylet schema and global blackboard engine.
* Build the formal graph compiler utilizing Petri Net reachability solvers to detect deadlocks, state reachability, and orphaned conditions.

### Phase 2: Authoring Environment & Inversion Tool
* Integrate the backward graph-walk algorithm into the node editor.
* Fine-tune a local 4B–8B model on paired graph-state and objective character dossiers.
* Enforce negative DPO tuning to eliminate unsolicited suggestions and ensure strictly descriptive output.

### Phase 3: Runtime Decision Model & Offline RL Pipeline
* Train the compact cross-encoder decision model on synthetic state transitions.
* Implement the telemetry logging pipeline to track player skip rates, save scums, and session drop-offs during internal testing builds.
* Calibrate the model using DPO with KL regularization against authorial baselines.
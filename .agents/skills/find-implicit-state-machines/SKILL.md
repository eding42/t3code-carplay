---
name: find-implicit-state-machines
description: Audit codebases for implicit state machines governed by boolean flag clusters, scattered status fields, and unmodeled async transitions. Use when analyzing state complexity, hunting concurrency/deadlock/ghost bugs, or auditing lifecycle architectures.
---

# Find implicit state machines

Audit a codebase for **implicit state machines** — behaviors governed by distinct modes or states that are **not** explicitly modeled. Instead, the modes emerge accidentally from boolean clusters, nullable fields, magic strings, scattered conditional guards, and distributed event handlers.

This is a **read-only analysis** skill. It diagnoses state architecture and produces actionable, evidence-backed findings without altering source code unless specifically instructed.

---

## 1. Definition

An implicit state machine exists when an entity has discrete operational phases or modes, but its states and transitions are not represented as an explicit finite state machine, statechart, reducer with a closed state union, or discriminated union.

### Strong signals

- **Flag clusters**: $N$ booleans describing a single concept (`isLoading`, `hasError`, `isSuccess`, `isRetrying`), where $2^N$ combinations exist syntactically but only a handful are valid.
- **Partially meaningful fields**: An `error` field populated while `status === "success"`, or `data` present during loading with no clarity on freshness.
- **Multiple uncoordinated writers**: The same status field or flag is updated from separate event handlers, network callbacks, effects, or IPC listeners without central transition guards.
- **Multi-step flows tracked by scattered flags**: Flows like onboarding, authentication, device pairing, worktree setup, checkout, or file uploads tracked across components via ad-hoc boolean combinations.
- **Async concurrency hazards**: Timeouts, retries, polling loops, WebSocket events, or IPC responses that can arrive late, duplicate, or out of order, writing to state that has already transitioned.

### Non-findings (do NOT report)

- A single independent boolean toggle (`isOpen` on an isolated dialog or dropdown) that does not interact with other flags.
- Purely derived values computed during render or query (`const isEmpty = items.length === 0`).
- Static configuration flags that never change at runtime.

---

## 2. Cross-platform audit process

This audit operates consistently across runtimes (Node, browser, Electron, React Native) and operating systems (macOS, Linux, Windows).

### Step 1: Map the surface & architecture boundaries

Map entry points, boundaries, and state containers before diving into individual files:

- **Server / Backend**: Orchestrators, services, long-running workers, event sinks, RPC handlers, database models.
- **Web**: React component state (`useState`, `useReducer`), global state (Jotai, Zustand, Redux), URL params, cached queries.
- **Desktop**: Electron main-to-renderer IPC, window lifecycle, background daemon processes.
- **Mobile**: React Native lifecycle, native module bridges, connection relays, background suspend/resume.

_Tip for agent harnesses with subagent capabilities:_ Split backend/services and frontend/clients into parallel subagents to maximize coverage.

### Step 2: Search for candidates

Use ripgrep or code search with cross-platform search patterns:

```bash
# Boolean flag clusters in interfaces or component state
rg "(is[A-Z]\w+.*boolean|has[A-Z]\w+.*boolean)" --type ts --type tsx

# Status string literals or enums updated across multiple files
rg "status\s*[:=]\s*['\"]" --type ts --type tsx

# Suspicious negated boolean guards / compound conditions
rg "if\s*\(!\w+\s*&&\s*!\w+\)" --type ts --type tsx
```

### Step 3: Trace before claiming

For each candidate, inspect every read and write site. Never claim a bug or invalid state based on property names alone:

- Verify the exact trigger path from user action, network event, timer, or IPC message.
- Check whether an enclosing mutex, transaction, or framework guarantee (e.g. React batching, SQLite serializability) prevents the apparent hazard.

### Step 4: Cluster repeated patterns

When a pattern repeats across many instances (e.g. 20 components sharing the same `{ loading, error, data }` tri-state), report it **once** as a systemic pattern with representative occurrences, rather than 20 redundant findings.

### Step 5: Analyze each real machine

For each confirmed or high-risk machine, document:

1. **Effective states**: The distinct states that actually occur in practice.
2. **State location**: Component state, atoms, refs, URL, SQLite columns, IPC state, external process.
3. **Transitions & triggers**: What causes transitions and which functions execute them.
4. **Illegal / surprising combinations**: What states the types permit that break runtime invariants.
5. **Concurrency hazards**: Double submits, out-of-order WebSocket/IPC messages, unmounted updates, race conditions.

### Step 6: Classify evidence level

- **Confirmed**: A concrete, traceable code path exists that reaches an invalid, deadlocked, or corrupt state.
- **Likely**: The data structure allows invalid states and no invariant guard prevents them, but triggering it requires specific timing or external failure.
- **Theoretical**: Syntactically permitted by types, but runtime flows or natural constraints make occurrence improbable.

---

## 3. Four-level fix hierarchy

Always recommend the smallest effective fix in order of preference:

1. **Delete or derive** (Smallest): Eliminate redundant flags entirely. Compute values on the fly from existing authoritative state (e.g., derive `hasError` from `error !== null`).
2. **Discriminated union / Status enum**: Collapse loose flags into a single tagged union so invalid states become unrepresentable in the type system:
   ```typescript
   // Before: 2^3 = 8 states, half invalid
   type State = { isLoading: boolean; error?: Error; data?: Data };

   // After: 3 legal states, compiler enforces invariants
   type State =
     | { status: "idle" }
     | { status: "loading" }
     | { status: "error"; error: Error }
     | { status: "success"; data: Data };
   ```
3. **Centralized reducer with transition guards**: Move scattered setter calls into a single transition function or reducer that rejects invalid transitions (e.g., ignoring `LOAD_SUCCESS` if state is no longer `loading`).
4. **Formal state machine / statechart**: Use an explicit FSM or state machine library only for mission-critical, high-complexity flows with 4+ asynchronous states, branching retries, or strict lifecycle requirements (e.g. thread orchestration, authentication handshakes, payment flows).

---

## 4. Report structure

Format findings using this markdown structure:

### Executive summary

A table summarizing identified machines ranked by risk:

| #   | Machine / Domain | Location | Representation | Evidence | Consequence |
| --- | ---------------- | -------- | -------------- | -------- | ----------- |

### Detailed findings

For each high-risk or confirmed machine:

- **Location**: `path/to/file.ts:line` (clickable file links).
- **Current representation**: The loose flags or fields.
- **Illegal state permitted**: Specific invalid combination.
- **Trigger trace**: Step-by-step sequence leading to failure.
- **State transition diagram**: Mermaid diagram showing valid vs broken transitions.
- **Recommended fix**: Concrete code sketch demonstrating the minimal effective fix.

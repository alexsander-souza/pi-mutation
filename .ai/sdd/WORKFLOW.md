# SDD Workflow Guide

> Purpose: Help humans and AI agents follow the SDD flow without adding extra process ceremony.
> Last Updated: 2026-08-12

## Simple Flow

```text
IDEA → PLAN → PRD → SPEC → TASKS → EXEC → REVIEW
```

## Step-by-Step

### 1. IDEA

Use when the direction is still unclear.

**Command:** `/skill:sdd-idea`

Use this to explore a raw idea, compare directions, identify users, value, risks, and constraints. Decide whether to continue, plan, or go directly to requirements.

**Output:** `.ai/sdd/ideas/001-feature-idea.md`

---

### 2. PLAN

Use when there are multiple features, phases, personas, or dependencies.

**Command:** `/skill:sdd-plan`

Use this to define MVP boundaries, organize features into phases, and map dependencies.

**Output:** `.ai/sdd/PLAN.md`

**Small feature shortcut:** skip PLAN and go directly to PRD.

---

### 3. PRD

Use to define WHAT and WHY.

**Command:** `/skill:sdd-prd`

Use this to write user stories, acceptance criteria, functional and non-functional requirements, and resolve requirement ambiguity.

**Output:** `.ai/sdd/specs/NNN-feature-name/requirements.md`

**Gate:** requirements must be explicitly approved before binding SPEC work.

---

### 4. SPEC

Use to define HOW.

**Command:** `/skill:sdd-spec`

Use this to map requirements to technical design, define architecture, components, data/state, APIs, and edge cases.

**Output:** `.ai/sdd/specs/NNN-feature-name/design.md`

**Gate:** design must be explicitly approved before binding TASKS work.

---

### 5. TASKS

Use to define implementation work and readiness.

**Command:** `/skill:sdd-tasks`

Use this to break approved design into small tasks, map requirements to tasks, define dependencies and verification.

**Output:** `.ai/sdd/specs/NNN-feature-name/tasks.md`

**Gate:** tasks must be explicitly approved before EXEC.

---

### 6. EXEC

Use to implement approved tasks.

**Command:** `/skill:sdd-exec`

Execute one approved task at a time. Record fresh verification evidence. Update task progress only after evidence exists.

**Allowed status:** `tasks:approved` or `implementation:in-progress`

---

### 7. REVIEW

Use after implementation to verify the result.

**Command:** `/skill:sdd-review`

Compare implementation against requirements, design, and tasks. Determine merge/readiness verdict.

**Output:** `.ai/sdd/specs/NNN-feature-name/review.md`

---

## Gates and Status

Each feature spec has a `.status` file — the source of truth for gate state.

```text
requirements:draft → requirements:approved
design:draft       → design:approved
tasks:draft        → tasks:approved
tasks:approved     → implementation:in-progress
implementation:in-progress → implementation:done
implementation:done → review:done
```

Rules:
- Drafts may be saved, but drafts do not unlock the next phase.
- File existence does not mean approval.
- Human approval is required for requirements, design, and tasks.

---

## If Unsure Where to Start

- Unclear idea → `/skill:sdd-idea`
- Multiple features → `/skill:sdd-plan`
- Known feature → `/skill:sdd-prd`
- Approved requirements → `/skill:sdd-spec`
- Approved design → `/skill:sdd-tasks`
- Approved tasks → `/skill:sdd-exec`
- Implemented feature → `/skill:sdd-review`
- Unsure current state → `/skill:sdd-status`

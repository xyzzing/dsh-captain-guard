# dsh-captain-guard

**Runtime-toggleable tool allowlist for the DSH Captain agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)

---

## Why this exists

Tool-augmented LLM agents are increasingly granted access to high-consequence actions, yet most tool-selection methods treat every tool as equally safe to expose. Recent work on capability minimization for tool-calling agents argues that **the visible tool set is a security control surface**: an exposed but unnecessary high-risk tool enlarges the attack surface and enables misuse via prompt injection. Tool visibility should be treated as temporary authority rather than passive capability — the principle of least privilege applied to agent tool exposure.

This is not theoretical. Least-privilege frameworks for tool-calling agents demonstrate that reconstructing permission hierarchies and enforcing least privilege at the tool level confines potential damage from unreliable LLMs. Work on delegation security for multi-agent systems proves that **authority does not attenuate as it passes from user to orchestrator to sub-agent to tool** — a compromised sub-agent inherits the full grant, and individually authorized actions can compose into prohibited outcomes.

`dsh-captain-guard` implements this principle at the DSH agent layer. It locks the Captain session's visible tool set to a read-only allowlist, so that even if the Captain is compromised by prompt injection, confused-deputy attacks, or reasoning drift, **the mutating tools simply do not exist in its catalog**.

### The role separation rationale

The Captain/Coder topology is not arbitrary. Work on adaptive in-conversation team building for language model agents demonstrates that role-specialized agents substantially outperform generalist single-agent approaches. Governance frameworks for agent teams describe the same pattern: a Captain decides which role should read, implement, validate, review, or assemble evidence for a task — and this role separation reduces single-agent drift.

The same literature establishes the **least-privilege execution model** this plugin enforces: team agents scale by role rather than by granting every worker broader authority. Permissions remain role-scoped. A Reviewer can inspect a draft without holding `file.write`; an Evidence Collector can summarize artifacts without holding `git.write`.

### Why the guard is toggleable at runtime

Static permissions are a known failure mode. Work on bounded agents notes that at session start, the agent's permissions are set but remain static, and each request is evaluated independently without considering prior actions. A runtime state file gives the operator the ability to revoke or grant the guard without restarting DSH — which matters when you are mid-investigation and need to widen or narrow the tool surface for a single session.

---

## What it does

When DSH creates an agent, `dsh-captain-guard` checks whether that agent's session header declares `agentPreset: captain`. If it does, the plugin applies `tools.restrict({ allow })` with a fixed allowlist, masking every other inherited tool on that agent's scope.

Workers, helper agents, and standard sessions are **untouched**. Only the Captain sees a reduced catalog.

```
┌──────────────────────────────────────────────────┐
│  Captain session (preset: "captain")             │
│  Visible tools: 12                                │
│  ├── graft_map, graft_skeleton, graft_ask        │
│  ├── fs_read_range                                │
│  └── agent_teams_* (coordination only)            │
│                                                   │
│  NOT visible: fs_write, bash, str_replace_editor  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  Worker session (preset: "standard")             │
│  Visible tools: all 27                            │
│  Untouched by this plugin                         │
└──────────────────────────────────────────────────┘
```

---

## Installation

### From GitHub (recommended)

```bash
# Pinned version — reproducible, supply-chain friendly
dsh plugin --profile web add github:YOUR_USERNAME/dsh-captain-guard#v0.1.0

# Latest from main — development only
dsh plugin --profile web add github:YOUR_USERNAME/dsh-captain-guard
```

### From npm (once published)

```bash
dsh plugin --profile web add dsh-captain-guard
```

### Prerequisites

You need an agent preset named `captain`. Create one by copying the built-in `standard` preset:

```bash
BASE="$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets"
mkdir -p ~/.dsh/.agent-presets/captain
cp "$BASE/standard/agent.cordis.yml" ~/.dsh/.agent-presets/captain/agent.cordis.yml

cat > ~/.dsh/.agent-presets/captain/preset.yml <<'YAML'
name: Captain (Read-Only)
description: Read-only Graft tools plus agent-teams coordination. No writes, no bash.
YAML
```

Restart DSH. A **Captain (Read-Only)** preset will appear in the session composer.

---

## Configuration

Mount it in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: captain-guard
      name: dsh-captain-guard
      config:
        enabled: true              # default state when no state file exists
        captainPreset: captain     # the preset ID to match (case-sensitive)
        allowlist:                 # optional override of the built-in list
          - graft_map
          - graft_skeleton
          - graft_ask
          - fs_read_range
          - agent_teams_create
          - agent_teams_add_member
          - agent_teams_status
          - agent_teams_task_create
          - agent_teams_task_list
          - agent_teams_task_get
          - agent_teams_task_update
          - agent_teams_message
```

| Field | Default | Purpose |
|-------|---------|---------|
| `enabled` | `true` | Initial state when no runtime state file exists |
| `captainPreset` | `"captain"` | The `agentPreset` value to match in the session header |
| `allowlist` | 12 tools | The exact set of tools the Captain may see |

---

## Runtime toggle

State is read at every `agent/created` event, so toggling takes effect on the **next agent you create** — no DSH restart needed.

```bash
# Turn the guard OFF
echo off > ~/.dsh/captain-guard.state

# Turn the guard ON
echo on  > ~/.dsh/captain-guard.state

# Reset to config default
rm ~/.dsh/captain-guard.state
```

### Shell aliases

```bash
alias captain-guard-on='echo on  > ~/.dsh/captain-guard.state && echo "captain-guard: ON"'
alias captain-guard-off='echo off > ~/.dsh/captain-guard.state && echo "captain-guard: OFF"'
alias captain-guard-status='cat ~/.dsh/captain-guard.state 2>/dev/null || echo "config default"'
```

The state file **takes priority over the config field**. This lets you override per-profile configuration at the operator level without editing YAML.

---

## Design decisions and why

Every choice in this plugin maps to a documented failure mode or empirical result from the agent-safety literature.

### Why restrict the tool catalog rather than filter calls at runtime

Most prior work evaluates tool selection by relevance or efficiency, surfacing tools whose names or schemas match the request. But this treats all tools as equally safe to show: a read-only search tool and an irreversible `delete_file` or `transfer_funds` tool are filtered by the same criterion.

Runtime filtering — inspecting tool calls as they are issued and rejecting dangerous ones — has a fundamental problem: the model still *sees* the tool, and prompt injection can still attempt to invoke it. The safer approach, and this plugin's, is to **remove the tool from the visible set entirely** unless it is both on a minimal causal path to the goal *and* gated by a satisfied authorization precondition.

The Captain never needs `fs_write` to do its job. So `fs_write` should not exist in the Captain's catalog. Not "be rejected if called" — **not exist**.

### Why the allowlist is a fixed constant, not a heuristic

General-purpose least-privilege frameworks reconstruct permission hierarchies that reflect relationships among tool calls, and combine them with mobile-style permission models. That is the right design for a general-purpose agent platform, where tools are unbounded and user-defined.

DSH's Captain role is **not** general-purpose. It has exactly one job: plan, decompose, delegate, and review. The tools it needs are known a priori and do not change between tasks. A fixed allowlist is both simpler and stricter than a reconstructed hierarchy, because there is no reconstruction step to get wrong.

### Why the allowlist is read-only

The Captain's strict restrictions — never write implementation logic, never edit source files — exist because role-separated orchestration reduces unnecessary token exposure by routing narrow read-only, validation, or review tasks to narrower role prompts or cheaper model tiers.

This is the **context shielding** principle: by barring the Captain from code editing and from whole-file reads, prompt token growth stays linear rather than exponential. The Captain dispatches; the Coder executes. Every token the Captain spends reading source code is a token not spent planning.

### Why the worker's `allowed_tools` matters more than the Captain's

Delegation-security work proves **Blast Radius Monotonicity** and **Composition Soundness** for the agentic principal chain: authority does not attenuate as it passes from orchestrator to sub-agent to tool. If the Captain has `fs_write` and delegates to a worker, the worker inherits it. If the worker has `fs_write` directly, the Captain's restriction is moot.

This is why the plugin restricts at the **tool catalog** level for both roles, not just at the call-filtering level. The Captain's allowlist is enforced by this plugin; the worker's allowlist is enforced by the `dsh-agent-teams` config. Together they close the loop.

### Why deterministic verification (the `test_command` contract)

The Captain's dispatch contract requires every task to specify a `test_command` that the worker must execute. This is not bureaucracy — it is the **deterministic gate** pattern.

Recent measurement work on deterministic gates reports substantial improvements on agent benchmarks with zero additional model calls: gates add no inference cost because their runtime is limited to deterministic reads and predicate evaluation. A claim is admitted only when a prediction, pre-registered before acting, is matched against observation by code.

The `test_command` is that prediction. The worker cannot mark a task complete without executing it.

### Why the guard targets the preset, not the role

The plugin detects the Captain by reading `agent.session.header.agentPreset`. This is the same identity signal that role-based orchestration uses to route tasks by role: a Captain decides which role should read, implement, validate, review, summarize, or assemble evidence for a task.

Using the preset name rather than a runtime role flag means the guard is **declarative and inspectable**. You can see, from the session header alone, which policy applies. There is no hidden state, no registration step, no chance of a race condition between role assignment and policy application.

### Why the runtime state file

The critique of static session permissions — that at session start the agent's permissions are set but remain static — is correct about the default case but not about the operational case. Sometimes you *want* to widen the tool surface mid-investigation, or narrow it after a suspected compromise.

A file-based toggle with immediate effect on the next agent creation is the minimum viable solution. It requires no DSH restart, no config edit, and no WebUI interaction. The operator's shell is the control plane.

### Why a single GPU needs a smaller context window

This plugin does not manage context, but it exists in a stack that must. The KV cache is the binding constraint on a 24 GB card running a 27B model. Work on KV-cache-centric serving for multi-agent systems shows that spatial contention leads to eviction of critical agents' caches, and that prefix caching alone is insufficient in the presence of limited GPU memory.

The response is to cap the context window at a value the hardware can actually sustain — 32k, not 98k — and to restrict what enters the window. Graft handles the second half; this plugin handles the first, by ensuring the Captain never pulls source files into its own context.

### Why `max_parallel_workers: 1`

The same KV-cache economics. Two concurrent workers on a single GPU means two KV caches competing for the same VRAM, with the decode step bounded by what crosses the interconnect when caches spill to host memory. One worker at a time keeps the cache resident and the token-generation speed at peak.

### Why the `agent_teams_*` tools are in the allowlist

The Captain's job is coordination. Removing the coordination tools would make the restriction self-defeating — the Captain could not dispatch a task, check status, or receive a result. The allowlist is not "the fewest tools possible"; it is "the tools the role actually needs, and no more." That is the least-privilege principle: an exposed but unnecessary high-risk tool enlarges the attack surface. The coordination tools are necessary. The write tools are not.

---

## Verification

After installing and restarting DSH, check the boot log:

```bash
timeout --kill-after=3s 10 dsh --profile web --no-open 2>&1 | grep -i captain-guard
```

Expected output:

```
[captain-guard] captain-guard loaded {"defaultEnabled":true,"currentState":"ON","stateSource":"config","captainPreset":"captain","allowCount":12}
[captain-guard] not the captain — skipping {"sessionId":"session-...","reason":"preset=\"standard\" (want \"captain\")"}
```

The second line is **correct behavior** — helper agents run under `standard`, not `captain`, so the guard skips them.

To verify enforcement, create a session with the **Captain (Read-Only)** preset and watch for:

```
[captain-guard] captain allowlist applied {"sessionId":"session-...","reason":"preset=\"captain\"","allowCount":12}
```

That line confirms the allowlist was applied.

---

## Compatibility

| DSH version | Status |
|-------------|--------|
| `0.1.5-alpha.*` and later | ✅ Tested |
| Earlier versions | ⚠️ Untested — the `agentPreset` session header field may not be present |

The plugin requires the `agent.session.header.agentPreset` field to be populated. This is present in all DSH versions that support agent presets.

---

## Research foundations

This plugin's design draws on the following strands of work. Each is cited by title so readers can locate the paper directly.

| Work | Relevance |
|------|-----------|
| **Capability Minimization as a Safety Primitive** | Tool visibility as temporary authority; least-privilege exposure |
| **MiniScope: A Least Privilege Framework for Authorizing Tool Calling Agents** | Permission hierarchy reconstruction; mobile-style permission model |
| **Bounded Agents: Delegation Security for Multi-Agent AI Systems** | Authority non-attenuation; Blast Radius Monotonicity; Composition Soundness |
| **Adaptive In-conversation Team Building for Language Model Agents** (Captain Agent) | Captain-worker topology; role specialization outperforms generalist agents |
| **Deterministic gates for agent verification** (reason-less-verify-more patterns) | Zero-model-call verification; prediction pre-registration |
| **The LLM Proposes, the Executive Disposes** | Deterministic Executive owns belief; structural verification |
| **Team Agents and Captain-style orchestration** | Role-scoped permissions; least-privilege execution model |
| **KV-cache-centric serving for multi-agent systems** (TokenCake and related) | KV-cache spatial contention; single-GPU concurrency limits |
| **KVFlow: Efficient Prefix Caching for Multi-Agent Workflows** | Prefix caching insufficient under limited GPU memory |

*To add specific arXiv IDs, verify each at `https://arxiv.org/abs/<id>` before publishing.*

---

## FAQ

### Does this plugin prevent prompt injection?

No. It **constrains the blast radius** of a successful injection. Delegation-security work notes that a prompt injection poses a risk only if the agent has authority to perform such actions. This plugin removes the authority. The model may still be manipulated; it simply cannot act on the manipulation through mutating tools.

### Does this replace the `dsh-agent-teams` worker allowlist?

No. They are complementary. This plugin restricts the **Captain**. The `agent-teams` config restricts the **workers**. Composition Soundness requires both: a restriction set is only sound if it covers every path by which authority can be exercised.

### What happens if the Captain is not using the `captain` preset?

The plugin skips it. It logs `not the captain — skipping` with the detected preset name. No restriction is applied. If you see this for a session you *intended* to be the Captain, check the preset selector in the session composer.

### Can I widen the allowlist for a specific task?

Edit the `allowlist` array in `cordis.patch.yml` and restart DSH. The allowlist is evaluated at `agent/created`, so a config change takes effect on the next agent. If you need per-session flexibility, use the runtime state file to disable the guard entirely for that session.

### Why not use `tools.restrict({ deny })` instead of `{ allow }`?

A deny-list requires you to enumerate every dangerous tool, and fails open when a new one is added. An allow-list requires you to enumerate the safe tools, and fails closed. The whole argument for capability minimization is that an exposed but unnecessary high-risk tool enlarges the attack surface. Fail-closed is the correct default.

### Does this work with non-`web` profiles?

Yes. Set `DSH_PROFILE` or pass `--profile` to all commands. The plugin itself is profile-agnostic; only the installation and config paths differ.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Contributing

Issues and PRs welcome. If you are extending the allowlist or changing the detection logic, please explain the reasoning in your PR description — the design is grounded in the papers listed above, and changes should be too.
# dsh-captain-guard

Runtime-toggleable tool allowlist for the DSH Captain agent.

## What it does

When a new agent is created, this plugin checks whether the agent is the
Captain (by preset name, or by presence of the `agent_teams_create` tool).
If so, it applies `tools.restrict({ allow })` with a fixed allowlist,
masking every other tool on that agent's scope. Workers and normal
sessions are untouched.

## Toggle without restarting DSH

State is read at every `agent/created`, so toggling takes effect on the
**next agent you create** — no restart needed.

    echo off > ~/.dsh/captain-guard.state   # turn OFF
    echo on  > ~/.dsh/captain-guard.state   # turn ON
    rm ~/.dsh/captain-guard.state           # reset to config

## Suggested shell aliases

    alias captain-guard-on='echo on  > ~/.dsh/captain-guard.state && echo "captain-guard: ON"'
    alias captain-guard-off='echo off > ~/.dsh/captain-guard.state && echo "captain-guard: OFF"'
    alias captain-guard-status='cat ~/.dsh/captain-guard.state 2>/dev/null || echo "config default"'

## Verification

After restarting DSH, grep the log for:

    [captain-guard] captain-guard loaded { ... currentState: 'ON' ... }

Then create a Captain session and confirm only the allowlist tools appear.

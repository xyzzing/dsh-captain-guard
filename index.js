'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ALLOWLIST = [
  'graft_map',
  'graft_skeleton',
  'graft_ask',
  'fs_read_range',
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_status',
  'agent_teams_task_create',
  'agent_teams_task_list',
  'agent_teams_task_get',
  'agent_teams_task_update',
  'agent_teams_message',
];

const STATE_FILE = path.join(os.homedir(), '.dsh', 'captain-guard.state');

function log(msg, data) {
  try {
    console.log(`[captain-guard] ${msg}`, data !== undefined ? JSON.stringify(data) : '');
  } catch (_) {}
}

function warn(msg, data) {
  try {
    console.warn(`[captain-guard] ${msg}`, data !== undefined ? JSON.stringify(data) : '');
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Shape adapters — derived from the real agent object dumped at boot:
//
//   agent.agent.session.header.agentPreset   ← preset name ("standard"|"captain")
//   agent.agent.id                            ← session id
//   agent.agent.loopCtx.fiber.ctx             ← Cordis context (services)
// ---------------------------------------------------------------------------

function innerAgent(agent) {
  return (agent && agent.agent) || agent || null;
}

function getPresetName(agent) {
  const a = innerAgent(agent);
  try {
    return (
      (a && a.session && a.session.header && a.session.header.agentPreset) ||
      (a && a.session && a.session.header && a.session.header.preset) ||
      null
    );
  } catch (_) {
    return null;
  }
}

function getSessionId(agent) {
  const a = innerAgent(agent);
  try {
    return (a && a.session && a.session.header && a.session.header.id) || null;
  } catch (_) {
    return null;
  }
}

// Resolve the Cordis context that owns the tools service.
// The fiber's own ctx is where Cordis services are registered.
function getFiberCtx(agent) {
  const a = innerAgent(agent);
  const candidates = [
    a && a.loopCtx && a.loopCtx.fiber && a.loopCtx.fiber.ctx,
    a && a.scope && a.scope.ctx,
    a && a.ctx,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }
  return null;
}

// Find the tools registry/service. Cordis exposes services either as direct
// properties on the fiber ctx, or via .get(name) / .service(name).
function getToolsService(ctx) {
  if (!ctx) return null;

  const direct = ['tools', 'toolRegistry', 'toolService'];
  for (const k of direct) {
    try {
      const v = ctx[k];
      if (v && typeof v === 'object') return v;
    } catch (_) {}
  }

  for (const method of ['get', 'service', 'inject']) {
    if (typeof ctx[method] === 'function') {
      for (const name of ['tools', 'toolRegistry', 'toolService']) {
        try {
          const v = ctx[method](name);
          if (v && typeof v === 'object') return v;
        } catch (_) {}
      }
    }
  }

  return null;
}

function describeToolsService(ts) {
  if (!ts) return 'null';
  try {
    const keys = Object.keys(ts).slice(0, 15);
    return `keys=[${keys.join(',')}]`;
  } catch (_) {
    return 'unreadable';
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = {
  name: 'captain-guard',

  apply(ctx, config) {
    const cfg = Object.assign(
      {
        enabled: true,
        captainPreset: 'captain',
        allowlist: DEFAULT_ALLOWLIST,
      },
      config || {},
    );

    function readState() {
      try {
        if (fs.existsSync(STATE_FILE)) {
          const raw = fs.readFileSync(STATE_FILE, 'utf8').trim().toLowerCase();
          if (['on', 'enabled', 'true', '1', 'yes'].includes(raw)) {
            return { enabled: true, source: `state-file:${raw}` };
          }
          if (['off', 'disabled', 'false', '0', 'no'].includes(raw)) {
            return { enabled: false, source: `state-file:${raw}` };
          }
          warn('state file unrecognized; using config', { content: raw });
        }
      } catch (err) {
        warn('state file read failed; using config', { error: err.message });
      }
      return { enabled: cfg.enabled !== false, source: 'config' };
    }

    function isCaptain(agent) {
      const preset = getPresetName(agent);
      if (cfg.captainPreset && preset && preset === cfg.captainPreset) {
        return { matched: true, reason: `preset="${preset}"` };
      }
      return {
        matched: false,
        reason: `preset="${preset || 'unknown'}" (want "${cfg.captainPreset}")`,
      };
    }

    function applyAllowlist(agent) {
      const fiberCtx = getFiberCtx(agent);
      if (!fiberCtx) {
        warn('no Cordis context found on agent', {
          sessionId: getSessionId(agent),
        });
        return false;
      }

      const tools = getToolsService(fiberCtx);
      if (!tools) {
        warn('tools service not found on fiber ctx', {
          sessionId: getSessionId(agent),
          fiberCtxKeys: (() => {
            try { return Object.keys(fiberCtx).slice(0, 20); }
            catch (_) { return []; }
          })(),
        });
        return false;
      }

      if (typeof tools.restrict !== 'function') {
        warn('tools service has no restrict() method', {
          sessionId: getSessionId(agent),
          tools: describeToolsService(tools),
        });
        return false;
      }

      const allow =
        Array.isArray(cfg.allowlist) && cfg.allowlist.length > 0
          ? cfg.allowlist
          : DEFAULT_ALLOWLIST;

      try {
        tools.restrict({ allow });
        return true;
      } catch (err) {
        warn('tools.restrict threw', {
          sessionId: getSessionId(agent),
          error: err.message,
        });
        return false;
      }
    }

    // -----------------------------------------------------------------
    // Subscribe
    // -----------------------------------------------------------------

    try {
      ctx.on('agent/created', (agent) => {
        try {
          const state = readState();
          const preset = getPresetName(agent);
          const sessionId = getSessionId(agent);

          if (!state.enabled) {
            log('guard is OFF — skipping', { preset, sessionId, source: state.source });
            return;
          }

          const detection = isCaptain(agent);
          if (!detection.matched) {
            log('not the captain — skipping', {
              sessionId,
              reason: detection.reason,
            });
            return;
          }

          const applied = applyAllowlist(agent);
          log(applied ? 'captain allowlist applied' : 'captain detected but allowlist NOT applied', {
            sessionId,
            reason: detection.reason,
            allowCount: (cfg.allowlist || DEFAULT_ALLOWLIST).length,
          });
        } catch (err) {
          warn('agent/created handler failed', { error: err.message, stack: err.stack });
        }
      });
    } catch (err) {
      warn('failed to subscribe to agent/created', { error: err.message });
    }

    const initialState = readState();
    log('captain-guard loaded', {
      defaultEnabled: cfg.enabled !== false,
      currentState: initialState.enabled ? 'ON' : 'OFF',
      stateSource: initialState.source,
      captainPreset: cfg.captainPreset,
      allowCount: (cfg.allowlist || DEFAULT_ALLOWLIST).length,
    });
  },
};

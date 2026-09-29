import type { Logger } from '@oasis-echo/telemetry';
import { PantheonMayaReasoner, type Reasoner } from '@oasis-echo/reasoning';

/**
 * The agents (projects) hosted Echo can talk to. An agent is a fast
 * "talker" that holds the live conversation, and optionally a slow
 * "expert" (e.g. Maya in Pantheon) the talker asks in the background when a
 * question needs it. Each agent lists who may use it; users only see those.
 * Configured as JSON in ECHO_AGENTS, e.g.
 *
 *   [{ "id": "maya", "name": "Maya", "project": "Pantheon",
 *      "allow": ["steve.tran@theaiinc.com"],
 *      "expert": { "kind": "pantheon", "name": "Maya",
 *                  "about": "the portfolio assistant: projects, boards, priorities",
 *                  "baseUrl": "https://pantheon.theaiinc.com", "tokenEnv": "PANTHEON_BOT_TOKEN",
 *                  "roles": { "steve.tran@theaiinc.com": "discord:767623901740007446" } } }]
 *
 * The talker comes from ECHO_TALKER_BASE_URL / ECHO_TALKER_MODEL /
 * ECHO_TALKER_TOKEN_ENV unless the agent sets its own "talker". Without a
 * talker key, every turn goes straight to the expert (slow but works).
 * The older flat form (kind/baseUrl/tokenEnv at the top) is read as the expert.
 */
export type ExpertConfig = {
  kind: 'pantheon';
  /** How the talker and the user refer to it, e.g. "Maya". */
  name: string;
  /** What it knows, for the talker deciding when to ask. */
  about?: string;
  baseUrl: string;
  /** Environment variable holding its credential. */
  tokenEnv: string;
  /** Conversation per user: "{email}" / "{sub}" filled in. Default "voice:{email}". */
  role?: string;
  roles?: Record<string, string>;
  /** First guess at how long it takes to answer, before it has answered. Default 60 s. */
  typicalSeconds?: number;
};

export type TalkerConfig = { baseUrl: string; model: string; tokenEnv: string; persona?: string };

export type AgentConfig = {
  id: string;
  name: string;
  project: string;
  /** Emails allowed to talk to it, or "*@domain". */
  allow: string[];
  talker?: TalkerConfig;
  expert?: ExpertConfig;
};

export type EchoUser = { sub: string; email: string };

export function loadAgents(json: string | undefined): AgentConfig[] {
  if (!json?.trim()) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error('ECHO_AGENTS must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((raw, i) => {
    const a = raw as Record<string, unknown>;
    for (const key of ['id', 'name', 'project'] as const) {
      if (typeof a[key] !== 'string' || !a[key]) throw new Error(`ECHO_AGENTS[${i}].${key} is required`);
    }
    const id = a['id'] as string;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`ECHO_AGENTS[${i}].id must be lowercase letters, digits or -`);
    if (seen.has(id)) throw new Error(`ECHO_AGENTS: duplicate id ${id}`);
    seen.add(id);
    const allow = a['allow'];
    if (!Array.isArray(allow) || allow.length === 0) throw new Error(`ECHO_AGENTS[${i}].allow must list who may use it`);
    const expertRaw = (a['expert'] ?? (a['kind'] ? { ...a, name: a['name'] } : undefined)) as Record<string, unknown> | undefined;
    let expert: ExpertConfig | undefined;
    if (expertRaw) {
      if (expertRaw['kind'] !== 'pantheon') throw new Error(`ECHO_AGENTS[${i}] expert kind "${String(expertRaw['kind'])}" is not supported`);
      for (const key of ['baseUrl', 'tokenEnv'] as const) {
        if (typeof expertRaw[key] !== 'string' || !expertRaw[key]) throw new Error(`ECHO_AGENTS[${i}].expert.${key} is required`);
      }
      const roles = (expertRaw['roles'] ?? {}) as Record<string, string>;
      expert = {
        kind: 'pantheon',
        name: String(expertRaw['name'] ?? a['name']),
        ...(typeof expertRaw['about'] === 'string' ? { about: expertRaw['about'] } : {}),
        baseUrl: expertRaw['baseUrl'] as string,
        tokenEnv: expertRaw['tokenEnv'] as string,
        ...(typeof expertRaw['role'] === 'string' ? { role: expertRaw['role'] } : {}),
        roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k.trim().toLowerCase(), v])),
        ...(typeof expertRaw['typicalSeconds'] === 'number' ? { typicalSeconds: expertRaw['typicalSeconds'] } : {}),
      };
    }
    const talker = a['talker'] as TalkerConfig | undefined;
    return {
      id,
      name: a['name'] as string,
      project: a['project'] as string,
      allow: (allow as string[]).map((e) => e.trim().toLowerCase()),
      ...(talker ? { talker } : {}),
      ...(expert ? { expert } : {}),
    };
  });
}

/** The talker for an agent: its own, or the deployment's default (null: none configured). */
export function talkerFor(agent: AgentConfig, env: NodeJS.ProcessEnv): (TalkerConfig & { apiKey: string }) | null {
  const t = agent.talker ?? (env['ECHO_TALKER_MODEL'] && env['ECHO_TALKER_TOKEN_ENV']
    ? { baseUrl: env['ECHO_TALKER_BASE_URL'] ?? 'https://api.llmapi.ai/v1', model: env['ECHO_TALKER_MODEL'], tokenEnv: env['ECHO_TALKER_TOKEN_ENV'] }
    : null);
  const apiKey = t ? env[t.tokenEnv] : undefined;
  return t && apiKey ? { ...t, apiKey } : null;
}

export function canUse(agent: AgentConfig, email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return false;
  const domain = e.slice(e.indexOf('@'));
  return agent.allow.some((rule) => rule === e || rule === `*${domain}`);
}

export function roleFor(expert: ExpertConfig, user: EchoUser): string {
  const email = user.email.trim().toLowerCase();
  const explicit = expert.roles?.[email];
  if (explicit) return explicit;
  return (expert.role ?? 'voice:{email}').replace('{email}', email).replace('{sub}', user.sub);
}

/** The expert as a Reasoner (it answers in one piece). */
export function makeExpert(expert: ExpertConfig, user: EchoUser, env: NodeJS.ProcessEnv, logger?: Logger): PantheonMayaReasoner {
  const token = env[expert.tokenEnv];
  if (!token) throw new Error(`expert ${expert.name}: ${expert.tokenEnv} is not set`);
  return new PantheonMayaReasoner({
    baseUrl: expert.baseUrl,
    botToken: token,
    role: roleFor(expert, user),
    ...(logger ? { logger } : {}),
  });
}

/** Back-compat for callers that only want "the agent's brain" with no talker. */
export function makeReasoner(agent: AgentConfig, user: EchoUser, env: NodeJS.ProcessEnv, logger?: Logger): Reasoner {
  if (!agent.expert) throw new Error(`agent ${agent.id} has no expert and no talker`);
  return makeExpert(agent.expert, user, env, logger);
}

import type { Logger } from '@oasis-echo/telemetry';
import { PantheonMayaReasoner, type Reasoner } from '@oasis-echo/reasoning';

/**
 * The agents (projects) hosted Echo can talk to. Each is its own brain with
 * its own credential and its own list of who may use it; users only ever
 * see the agents they are allowed. Configured as JSON in ECHO_AGENTS, e.g.
 *
 *   [{ "id": "maya", "name": "Maya", "project": "Pantheon", "kind": "pantheon",
 *      "baseUrl": "https://pantheon.theaiinc.com", "tokenEnv": "PANTHEON_BOT_TOKEN",
 *      "allow": ["steve.tran@theaiinc.com"],
 *      "roles": { "steve.tran@theaiinc.com": "discord:767623901740007446" } }]
 *
 * Adding a project = adding an entry (and, for a new kind of brain, a case in
 * makeReasoner).
 */
export type AgentConfig = {
  id: string;
  name: string;
  project: string;
  kind: 'pantheon';
  baseUrl: string;
  /** Name of the environment variable that holds this agent's credential. */
  tokenEnv: string;
  /** Emails allowed to talk to it, or "*@domain" for a whole domain. */
  allow: string[];
  /** The conversation a user talks in: "{email}" / "{sub}" are filled in. Default "voice:{email}". */
  role?: string;
  /** Per-email conversation, e.g. to continue the one you have in Discord. */
  roles?: Record<string, string>;
};

export type EchoUser = { sub: string; email: string };

export function loadAgents(json: string | undefined): AgentConfig[] {
  if (!json?.trim()) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error('ECHO_AGENTS must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((raw, i) => {
    const a = raw as Partial<AgentConfig>;
    for (const key of ['id', 'name', 'project', 'kind', 'baseUrl', 'tokenEnv'] as const) {
      if (typeof a[key] !== 'string' || !a[key]) throw new Error(`ECHO_AGENTS[${i}].${key} is required`);
    }
    if (a.kind !== 'pantheon') throw new Error(`ECHO_AGENTS[${i}].kind "${a.kind}" is not supported`);
    if (!/^[a-z0-9-]+$/.test(a.id!)) throw new Error(`ECHO_AGENTS[${i}].id must be lowercase letters, digits or -`);
    if (seen.has(a.id!)) throw new Error(`ECHO_AGENTS: duplicate id ${a.id}`);
    seen.add(a.id!);
    if (!Array.isArray(a.allow) || a.allow.length === 0) throw new Error(`ECHO_AGENTS[${i}].allow must list who may use it`);
    return {
      ...(a as AgentConfig),
      allow: a.allow.map((e) => e.trim().toLowerCase()),
      roles: Object.fromEntries(Object.entries(a.roles ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v])),
    };
  });
}

export function canUse(agent: AgentConfig, email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return false;
  const domain = e.slice(e.indexOf('@'));
  return agent.allow.some((rule) => rule === e || rule === `*${domain}`);
}

export function roleFor(agent: AgentConfig, user: EchoUser): string {
  const email = user.email.trim().toLowerCase();
  const explicit = agent.roles?.[email];
  if (explicit) return explicit;
  return (agent.role ?? 'voice:{email}').replace('{email}', email).replace('{sub}', user.sub);
}

export function makeReasoner(
  agent: AgentConfig,
  user: EchoUser,
  env: NodeJS.ProcessEnv,
  logger?: Logger,
): Reasoner {
  const token = env[agent.tokenEnv];
  if (!token) throw new Error(`agent ${agent.id}: ${agent.tokenEnv} is not set`);
  switch (agent.kind) {
    case 'pantheon':
      return new PantheonMayaReasoner({
        baseUrl: agent.baseUrl,
        botToken: token,
        role: roleFor(agent, user),
        ...(logger ? { logger } : {}),
      });
  }
}

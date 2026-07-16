import type { AgentContext, PostProcessContext, PostProcessStage, PostProcessStepResult } from './types.js';

const MIN_ECHO_TOKENS = 5;
const MAX_REPLY_TOKENS = 8;
const LEADING_REPLY_FILLER = /^(?:the|a|an|uh|um|yeah|yes|no|okay|ok)\s+/i;

/**
 * Removes assistant-question echo from STT candidates.
 *
 * The R1 mic can capture the tail of the assistant's own follow-up question
 * immediately before the user's short answer, e.g.
 *
 *   agent: "Do you have a specific genre ... comedy or fantasy?"
 *   STT:   "a specific genre ... comedy or fantasy the fantasy"
 *
 * The dialogue router should see "fantasy", not the echoed prompt.
 */
export class EchoedAgentQuestionStage implements PostProcessStage {
  readonly name = 'agent-question-echo';

  shouldRun(ctx: PostProcessContext): boolean {
    return Boolean(
      ctx.text.trim() &&
        ctx.agentContext?.lastUtterance?.trim() &&
        ctx.agentContext?.pendingQuestion,
    );
  }

  run(ctx: PostProcessContext): PostProcessStepResult {
    const trimmed = ctx.text.trim();
    const agent = ctx.agentContext;
    if (!agent?.lastUtterance) return { text: ctx.text, changed: false };

    const userTokens = tokenize(trimmed);
    const agentTokens = tokenize(agent.lastUtterance);
    if (userTokens.length < MIN_ECHO_TOKENS + 1 || agentTokens.length < MIN_ECHO_TOKENS) {
      return { text: ctx.text, changed: false };
    }

    const echoedTokens = longestPrefixSubsequence(userTokens, agentTokens);
    if (echoedTokens < MIN_ECHO_TOKENS || echoedTokens >= userTokens.length) {
      return { text: ctx.text, changed: false };
    }

    const replyTokens = userTokens.slice(echoedTokens);
    if (replyTokens.length > MAX_REPLY_TOKENS) return { text: ctx.text, changed: false };

    const reply = cleanShortReply(replyTokens.join(' '), agent);
    if (!reply || reply === trimmed) return { text: ctx.text, changed: false };

    return {
      text: reply,
      changed: true,
      info: {
        echoedTokens,
        replyTokens: replyTokens.length,
        pendingQuestion: agent.pendingQuestion?.kind,
      },
    };
  }
}

function longestPrefixSubsequence(userTokens: string[], agentTokens: string[]): number {
  let agentIndex = 0;
  let matched = 0;
  for (const token of userTokens) {
    let found = false;
    while (agentIndex < agentTokens.length) {
      if (agentTokens[agentIndex] === token) {
        found = true;
        agentIndex++;
        break;
      }
      agentIndex++;
    }
    if (!found) break;
    matched++;
  }
  return matched;
}

function cleanShortReply(reply: string, agent: AgentContext): string {
  let cleaned = reply.replace(LEADING_REPLY_FILLER, '').trim();
  if (!cleaned) cleaned = reply.trim();

  const options = agent.pendingQuestion?.options ?? [];
  if (options.length > 0) {
    const compact = cleaned.toLowerCase();
    const option = options.find((candidate) => {
      const head = tokenize(candidate)[0];
      return Boolean(head && compact.split(/\s+/).includes(head));
    });
    if (option) return option.trim();
  }

  return cleaned;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\b(?:you'?re)\b/g, 'you are')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

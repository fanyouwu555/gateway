/**
 * Post Processor — unified request side effects (metrics, quota, billing, logs)
 * Extracted from chat.ts to reduce duplication between streaming and non-streaming paths
 */
import type { Context } from 'hono';
import type { IApiKeyMeta, ChatMessage, ChatTool, ChatToolCall } from '../types';
import { recordMetric } from './metrics';
import { recordUsage } from './quota';
import { recordKeyCost } from './billing';
import { deductBalance } from './wallet';
import { getRequestLogStore } from './request-log';
import { getConversationLogService } from './conversation-log';
import { getPricingService } from './pricing';
import { getTokenRateLimit } from './token-ratelimit';
import { recordAiTokens, recordAiCost } from '../middleware/metrics';
import { writeLog } from '../utils/logger';

export interface PostProcessContext {
  c: Context;
  tenantId?: string;
  keyHash?: string;
  model: string;
  provider: string;
  latencyMs: number;
  statusCode: number;
  tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  content?: string;
  reasoningContent?: string;
  toolCalls?: ChatToolCall[];
  requestBody: unknown;
  error?: Error;
  isStream: boolean;
  sessionId: string;
  sessionSource?: { id: string; providedByHeader?: string };
}

export interface PostProcessResult {
  cost: number;
  remainingBalanceMicroYuan?: number;
}

export async function runPostProcessing(ctx: PostProcessContext): Promise<PostProcessResult> {
  const {
    c,
    tenantId,
    keyHash,
    model,
    provider,
    latencyMs,
    statusCode,
    tokens,
    content,
    reasoningContent,
    toolCalls,
    requestBody,
    error,
    isStream,
    sessionId,
    sessionSource,
  } = ctx;

  const requestId = c.get('request_id') as string;
  const cost = getPricingService().calculateCost(model, tokens.prompt_tokens, tokens.completion_tokens);

  // Metrics
  recordMetric(
    requestId,
    tenantId,
    provider,
    model,
    latencyMs,
    statusCode,
    tokens,
    keyHash,
    c.get('key_metadata'),
  );

  // AI tokens metric
  recordAiTokens(tokens.prompt_tokens, tokens.completion_tokens, provider, model);

  // Quota
  if (tenantId) {
    await recordUsage(tenantId, tokens.total_tokens);
  }

  // Billing & prepaid deduction
  let remainingBalanceMicroYuan: number | undefined;
  if (keyHash && statusCode === 200) {
    await recordKeyCost(keyHash, cost);
    recordAiCost(cost, provider, model);

    const billingMode = c.get('key_billing_mode') as IApiKeyMeta['billing_mode'];
    if (billingMode === 'prepaid') {
      const costMicroYuan = Math.ceil(cost * 1_000_000);
      const deductResult = await deductBalance(keyHash, costMicroYuan, {
        request_id: requestId,
        model,
        provider,
      });
      remainingBalanceMicroYuan = deductResult.newBalance;
      if (!deductResult.success) {
        writeLog('warn', `Prepaid overdraft in ${isStream ? 'streaming' : 'non-streaming'}`, {
          key_hash: keyHash,
          cost_micro_yuan: costMicroYuan,
          new_balance: deductResult.newBalance,
        });
      }
    }
  }

  // Token rate limit
  const trl = getTokenRateLimit();
  if (trl && statusCode === 200) {
    trl.consume(model, tokens.total_tokens);
  }

  // Conversation log
  if (content !== undefined) {
    const conversationLogService = getConversationLogService();
    const turn = {
      turn_id: requestId,
      session_id: sessionId,
      timestamp: Date.now(),
      request: {
        messages: (requestBody as { messages?: ChatMessage[] })?.messages || [],
        tools: (requestBody as { tools?: ChatTool[] })?.tools,
        model,
      },
      response: {
        content,
        reasoning_content: reasoningContent,
        tool_calls: toolCalls,
        usage: tokens,
      },
      metadata: {
        provider,
        duration_ms: latencyMs,
        cost,
        status_code: statusCode,
        tenant_id: tenantId,
        client_info: c.get('client_info'),
        session_source: sessionSource,
        user_agent: c.get('user_agent'),
        error: error?.message,
      },
    };
    conversationLogService.saveTurn(turn).catch((err: Error) => {
      writeLog('warn', 'Failed to save conversation turn', { error: err.message });
    });
  }

  // Request log
  const logStore = getRequestLogStore();
  if (logStore.shouldSample()) {
    const stringBody = JSON.stringify(requestBody);
    const sanitizedBody = stringBody.replace(/"api_key":"[^"]+"/g, '"api_key":"***"');
    logStore.add({
      request_id: requestId,
      tenant_id: tenantId,
      timestamp: Date.now(),
      method: 'POST',
      path: '/v1/chat/completions',
      provider,
      model,
      status_code: statusCode,
      duration_ms: latencyMs,
      prompt_tokens: tokens.prompt_tokens,
      completion_tokens: tokens.completion_tokens,
      total_tokens: tokens.total_tokens,
      request_body: sanitizedBody,
      response_body: JSON.stringify({ stream: isStream, usage: tokens }),
      cost,
    });
  }

  return { cost, remainingBalanceMicroYuan };
}

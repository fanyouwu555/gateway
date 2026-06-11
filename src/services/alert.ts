/**
 * 告警规则引擎
 * 基于阈值 + Webhook 通知
 * 支持内存存储（默认）和 Redis 持久化（可选）
 */
import { writeLog } from '../utils/logger';
import { fetchWithAgent } from '../utils/http-client';
import { getDashboardOverview } from './metrics';
import { createKVStore } from '../stores/factory';
import type { IKVStore } from '../stores/interface';
import { shouldUseRedis } from '../utils';

/**
 * 告警规则
 */
export interface AlertRule {
  id: string;
  name: string;
  metric: 'error_rate' | 'avg_latency_ms' | 'total_requests';
  threshold: number;
  condition: 'gt' | 'lt';
  webhook_url: string;
  enabled: boolean;
  cooldown_seconds: number;
}

/**
 * 告警状态
 */
interface AlertState {
  rule_id: string;
  status: 'firing' | 'resolved';
  last_fired_at: number;
  last_value: number;
}

const RULES_KEY = 'alert:rules';
const STATES_KEY = 'alert:states';

class AlertEngine {
  private rules: AlertRule[] = [];
  private states = new Map<string, AlertState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private useRedis = false;
  private store: IKVStore | null = null;

  constructor() {
    this.useRedis = shouldUseRedis('ALERT_STORAGE');
    if (this.useRedis) {
      this.store = createKVStore('alert');
    }
  }

  /**
   * 初始化存储连接，从 Redis 加载规则和状态
   */
  async init(): Promise<void> {
    if (this.useRedis && this.store) {
      await this.store.connect();
      await this.loadFromStorage();
    }
  }

  /**
   * 从存储加载规则和状态
   */
  private async loadFromStorage(): Promise<void> {
    if (!this.store) return;
    try {
      const rulesHash = await this.store.hGetAll(RULES_KEY);
      const loadedRules: AlertRule[] = [];
      for (const value of Object.values(rulesHash)) {
        try {
          loadedRules.push(JSON.parse(value) as AlertRule);
        } catch {
          // 忽略损坏的数据
        }
      }
      if (loadedRules.length > 0) {
        this.rules = loadedRules;
        writeLog('info', 'Alert rules loaded from storage', { count: loadedRules.length });
      }

      const statesHash = await this.store.hGetAll(STATES_KEY);
      for (const [key, value] of Object.entries(statesHash)) {
        try {
          this.states.set(key, JSON.parse(value) as AlertState);
        } catch {
          // 忽略损坏的数据
        }
      }
    } catch (err) {
      writeLog('warn', 'Failed to load alert data from storage', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 将规则同步到存储
   */
  private async persistRules(): Promise<void> {
    if (!this.store) return;
    try {
      for (const rule of this.rules) {
        await this.store.hSet(RULES_KEY, rule.id, JSON.stringify(rule));
      }
    } catch (err) {
      writeLog('warn', 'Failed to persist alert rules', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 将状态同步到存储
   */
  private async persistState(ruleId: string): Promise<void> {
    if (!this.store) return;
    try {
      const state = this.states.get(ruleId);
      if (state) {
        await this.store.hSet(STATES_KEY, ruleId, JSON.stringify(state));
      }
    } catch (err) {
      writeLog('warn', 'Failed to persist alert state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 从存储删除规则
   */
  private async removeRuleFromStorage(ruleId: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.hDel(RULES_KEY, ruleId);
      await this.store.hDel(STATES_KEY, ruleId);
    } catch (err) {
      writeLog('warn', 'Failed to remove alert rule from storage', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 添加规则
   */
  async addRule(rule: AlertRule): Promise<void> {
    const existing = this.rules.findIndex((r) => r.id === rule.id);
    if (existing >= 0) {
      this.rules[existing] = rule;
    } else {
      this.rules.push(rule);
    }
    await this.persistRules();
  }

  /**
   * 删除规则
   */
  async removeRule(id: string): Promise<boolean> {
    const initial = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    this.states.delete(id);
    if (initial !== this.rules.length) {
      await this.removeRuleFromStorage(id);
    }
    return this.rules.length < initial;
  }

  /**
   * 列出规则
   */
  listRules(): AlertRule[] {
    return [...this.rules];
  }

  /**
   * 启用/禁用规则
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    await this.persistRules();
    return true;
  }

  /**
   * 启动定时检查
   */
  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * 停止定时检查
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 手动触发一次评估
   */
  evaluate(): void {
    const now = Date.now();
    const windowStart = now - 5 * 60 * 1000; // 最近 5 分钟数据
    const overview = getDashboardOverview(windowStart, now);

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      const currentValue = this.getMetricValue(rule.metric, overview);
      const triggered = rule.condition === 'gt'
        ? currentValue > rule.threshold
        : currentValue < rule.threshold;

      const state = this.states.get(rule.id);
      const inCooldown = state
        && state.status === 'firing'
        && now - state.last_fired_at < rule.cooldown_seconds * 1000;

      if (triggered && !inCooldown) {
        this.fire(rule, currentValue);
        this.states.set(rule.id, {
          rule_id: rule.id,
          status: 'firing',
          last_fired_at: now,
          last_value: currentValue,
        });
        this.persistState(rule.id).catch(() => {});
      } else if (!triggered && state?.status === 'firing') {
        this.resolve(rule, currentValue);
        this.states.set(rule.id, {
          rule_id: rule.id,
          status: 'resolved',
          last_fired_at: state.last_fired_at,
          last_value: currentValue,
        });
        this.persistState(rule.id).catch(() => {});
      }
    }
  }

  private getMetricValue(
    metric: AlertRule['metric'],
    overview: ReturnType<typeof getDashboardOverview>
  ): number {
    switch (metric) {
      case 'error_rate':
        return overview.error_rate;
      case 'avg_latency_ms':
        return overview.avg_duration_ms;
      case 'total_requests':
        return overview.total_requests;
    }
  }

  private async fire(rule: AlertRule, value: number): Promise<void> {
    writeLog('warn', 'Alert firing', { rule: rule.name, value, threshold: rule.threshold });
    await this.sendWebhook(rule, 'firing', value);
  }

  private async resolve(rule: AlertRule, value: number): Promise<void> {
    writeLog('info', 'Alert resolved', { rule: rule.name, value, threshold: rule.threshold });
    await this.sendWebhook(rule, 'resolved', value);
  }

  private async sendWebhook(rule: AlertRule, status: string, value: number): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fetchWithAgent(rule.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rule_id: rule.id,
            rule_name: rule.name,
            status,
            metric: rule.metric,
            threshold: rule.threshold,
            current_value: value,
            condition: rule.condition,
            timestamp: new Date().toISOString(),
          }),
        });
        return; // success
      } catch (error) {
        const isLastAttempt = attempt === maxRetries - 1;
        if (isLastAttempt) {
          writeLog('error', 'Failed to send alert webhook after retries', {
            rule_id: rule.id,
            error: error instanceof Error ? error.message : String(error),
            attempts: maxRetries,
          });
        } else {
          // Exponential backoff: 200ms, 500ms, 1000ms
          const delay = Math.min(200 * Math.pow(2, attempt), 1000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }
}

// 单例
const alertEngine = new AlertEngine();

export function getAlertEngine(): AlertEngine {
  return alertEngine;
}

export async function addAlertRule(rule: AlertRule): Promise<void> {
  await alertEngine.addRule(rule);
}

export async function removeAlertRule(id: string): Promise<boolean> {
  return alertEngine.removeRule(id);
}

export function listAlertRules(): AlertRule[] {
  return alertEngine.listRules();
}

export async function setAlertEnabled(id: string, enabled: boolean): Promise<boolean> {
  return alertEngine.setEnabled(id, enabled);
}

export async function startAlertEngine(intervalMs?: number): Promise<void> {
  await alertEngine.init();
  alertEngine.start(intervalMs);
}

export function stopAlertEngine(): void {
  alertEngine.stop();
}

export function evaluateAlerts(): void {
  alertEngine.evaluate();
}

/**
 * 重置告警引擎（用于测试）
 */
export function resetAlertEngine(): void {
  alertEngine.stop();
  alertEngine.listRules().forEach((r) => {
    alertEngine.removeRule(r.id).catch(() => {});
  });
  alertEngine['states'].clear();
}

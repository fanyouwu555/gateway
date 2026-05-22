/**
 * 告警规则引擎
 * 基于阈值 + Webhook 通知
 */
import { writeLog } from '../utils/logger';
import { fetchWithAgent } from '../utils/http-client';
import { getDashboardOverview } from './metrics';

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

class AlertEngine {
  private rules: AlertRule[] = [];
  private states = new Map<string, AlertState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 添加规则
   */
  addRule(rule: AlertRule): void {
    const existing = this.rules.findIndex((r) => r.id === rule.id);
    if (existing >= 0) {
      this.rules[existing] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /**
   * 删除规则
   */
  removeRule(id: string): boolean {
    const initial = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    this.states.delete(id);
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
  setEnabled(id: string, enabled: boolean): boolean {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }

  /**
   * 启动定时检查
   */
  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), intervalMs);
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
      } else if (!triggered && state?.status === 'firing') {
        this.resolve(rule, currentValue);
        this.states.set(rule.id, {
          rule_id: rule.id,
          status: 'resolved',
          last_fired_at: state.last_fired_at,
          last_value: currentValue,
        });
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
    } catch (error) {
      writeLog('error', 'Failed to send alert webhook', {
        rule_id: rule.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// 单例
const alertEngine = new AlertEngine();

export function getAlertEngine(): AlertEngine {
  return alertEngine;
}

export function addAlertRule(rule: AlertRule): void {
  alertEngine.addRule(rule);
}

export function removeAlertRule(id: string): boolean {
  return alertEngine.removeRule(id);
}

export function listAlertRules(): AlertRule[] {
  return alertEngine.listRules();
}

export function setAlertEnabled(id: string, enabled: boolean): boolean {
  return alertEngine.setEnabled(id, enabled);
}

export function startAlertEngine(intervalMs?: number): void {
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
  alertEngine.listRules().forEach((r) => alertEngine.removeRule(r.id));
  alertEngine['states'].clear();
}

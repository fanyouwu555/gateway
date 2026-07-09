/**
 * 分阶段启动工具
 * 将初始化过程分为 critical / best-effort 阶段，
 * critical 阶段任一失败会中断启动，best-effort 阶段失败只记录日志。
 */
import { writeLog } from './logger';

export interface StartupPhase {
  name: string;
  critical: boolean;
  inits: Array<() => Promise<void>>;
}

export async function runStartup(phases: StartupPhase[]): Promise<void> {
  for (const phase of phases) {
    writeLog('info', `Startup phase: ${phase.name}`);
    if (phase.critical) {
      // Critical: 并行执行，任一失败即抛出，中断启动
      await Promise.all(phase.inits.map((init) => init()));
    } else {
      // Best-effort: 并行执行，记录失败但不中断
      const results = await Promise.allSettled(phase.inits.map((init) => init()));
      for (const result of results) {
        if (result.status === 'rejected') {
          writeLog('warn', `Non-critical init failed in ${phase.name}`, {
            error: String(result.reason),
          });
        }
      }
    }
  }
}

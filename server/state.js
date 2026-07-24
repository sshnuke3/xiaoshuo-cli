// server/state.js
// 集中管理 xiaoshuo-cli 的项目状态机
// 状态转换由这里单一来源控制，避免散落在各命令里的硬编码判断

/**
 * 项目状态枚举。
 * 状态流：draft → planning → ready → writing → completed
 *   - draft           作品刚创建
 *   - planning        大纲生成中（异步）
 *   - planning_failed 大纲生成失败（可重试，会回到 planning）
 *   - ready           大纲已确认，等待写作
 *   - writing         正在写作（任意章节进行中）
 *   - completed       全部章节写完
 */
export const STATES = Object.freeze([
  'draft',
  'planning',
  'planning_failed',
  'ready',
  'writing',
  'completed',
]);

/**
 * 合法状态转换表。
 *   key: 当前状态
 *   value: 允许转入的状态数组
 */
const TRANSITIONS = Object.freeze({
  draft: ['planning'],
  planning: ['ready', 'planning_failed'],
  planning_failed: ['planning'],
  ready: ['writing'],
  writing: ['ready', 'completed'],
  completed: ['writing'],
});

/**
 * 检查 from → to 是否合法。
 * 同状态 self-loop 视为合法（idempotent 写入）——例如异步任务回调
 * 里同时把 status 写成同一状态，是常见副作用，不应报错。
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * 断言状态转换合法，不合法抛出带中文提示的错误
 * @throws {Error} 状态转换不合法时
 */
export function assertTransition(from, to) {
  if (!STATES.includes(from)) {
    throw new Error(`未知当前状态: ${from}（合法: ${STATES.join(' / ')}）`);
  }
  if (!STATES.includes(to)) {
    throw new Error(`未知目标状态: ${to}（合法: ${STATES.join(' / ')}）`);
  }
  if (from === to) {
    return; // 同状态幂等
  }
  if (!canTransition(from, to)) {
    const allowed = TRANSITIONS[from].join('、');
    throw new Error(`状态 ${from} → ${to} 非法；合法目标: ${allowed}`);
  }
}

/**
 * 状态中文描述 + 下一步建议
 * @returns {{label: string, next: string}}
 */
export function describeState(state) {
  const map = {
    draft: { label: '已创建', next: '运行 `xiaoshuo outline` 生成大纲' },
    planning: { label: '大纲生成中', next: '等待异步任务完成' },
    planning_failed: { label: '大纲生成失败', next: '重新运行 `xiaoshuo outline` 重试' },
    ready: { label: '大纲已确认', next: '运行 `xiaoshuo write <id> <章号>` 写作' },
    writing: { label: '写作中', next: '运行 `xiaoshuo write <id> <章号>` 继续写' },
    completed: { label: '已完结', next: '运行 `xiaoshuo write <id> <章号>` 续写或 `export` 导出' },
  };
  return map[state] || { label: '未知', next: '' };
}

/**
 * 计算 phase 进度（用于 cmdShow 进度条）
 *   6 个状态映射到 0-5 整数
 * @returns {number} 0-5
 */
export function phaseProgress(state) {
  const order = ['draft', 'planning', 'planning_failed', 'ready', 'writing', 'completed'];
  return order.indexOf(state);
}

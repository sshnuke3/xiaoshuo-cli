#!/usr/bin/env node
/**
 * xiaoshuo-cli — 命令行入口
 *
 * 基于 TvTink/xiaoshuo (https://cnb.cool/TvTink/xiaoshuo) 的后端模块，
 * 在不启动 Express 的前提下提供 CLI 工具，所有 LLM 调度、上下文记忆、
 * SQLite 持久化逻辑 100% 沿用原作者实现。
 *
 * 使用方法：
 *   xiaoshuo list
 *   xiaoshuo config
 *   xiaoshuo new [-t 标题] [-g 类型] [-c 章数]
 *   xiaoshuo outline <id>
 *   xiaoshuo write <id> <章节号>
 *   xiaoshuo continue <id> [起始章节]
 *   xiaoshuo export <id> > 书名.txt
 *   xiaoshuo derive <id> --mode sequel
 *   xiaoshuo delete <id>
 */

import { v4 as uuid } from 'uuid';
import * as db from './server/db.js';
import { chat, chatStream } from './server/llm.js';
import {
  afterChapterWritten,
  buildWritingContext,
  generateOutline,
  getOutlineBatchCount,
  rebuildGlobalSummaryBefore,
  regenerateContinuationOutline,
  writeChapter,
} from './server/context.js';
import { describeState, phaseProgress, STATES, canTransition } from './server/state.js';

// 写作可期的状态集合：已确认大纲（ready） 或 正在写（writing） 或 已完结可续写（completed）
function canTransitionToWrite(currentStatus) {
  return canTransition(currentStatus, 'writing');
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.blue}ℹ${C.reset} ${msg}`);
const warn = (msg) => console.log(`${C.yellow}!${C.reset} ${msg}`);
const err = (msg) => console.error(`${C.red}✗${C.reset} ${msg}`);
const head = (msg) => console.log(`\n${C.bold}${C.cyan}${msg}${C.reset}\n${'─'.repeat(msg.length)}`);

// ──────────────────────────── 参数解析 ────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  // 找第一个非 flag token 作为命令
  let cmdEnd = args.findIndex((a, i) => !a.startsWith('-'));
  if (cmdEnd === -1) cmdEnd = args.length;
  const cmd = args.slice(0, cmdEnd).find((a) => !a.startsWith('-')) || args[0];
  const rest = args.slice(cmdEnd + 1);
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = rest[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

function usage() {
  console.log(`${C.bold}xiaoshuo-cli${C.reset} — 长篇小说生成器 CLI

${C.bold}用法:${C.reset}
  xiaoshuo list                                列出所有作品
  xiaoshuo config                              配置 LLM（交互式）
  xiaoshuo new [-t 标题] [-g 类型] [-c 章数] [-e 附加设定]   新建作品
  xiaoshuo show <id>                           显示作品详情
  xiaoshuo outline <id>                        生成大纲
  xiaoshuo outline-confirm <id>                确认大纲，进入可写作状态
  xiaoshuo write <id> <章号>                   写指定章节
  xiaoshuo continue <id> [起始章]              从某章连续写到结尾
  xiaoshuo regenerate <id> <起始章> <新章数>    重规划后续大纲
  xiaoshuo derive <id> --mode sequel|template  衍生续作/复用模板
  xiaoshuo export <id>                         导出为 TXT（stdout）
  xiaoshuo delete <id>                         删除作品

${C.bold}配置项（环境变量或 settings 表）:${C.reset}
  XIAOSHUO_BASE_URL  /  base_url    OpenAI 兼容接口地址
  XIAOSHUO_API_KEY   /  api_key     API Key
  XIAOSHUO_MODEL     /  model       模型名
`);
}

// ──────────────────────────── 配置管理 ────────────────────────────

function loadSettings() {
  return db.getAllSettings();
}

// 章节后处理：thinking 模型在正文后还会追加 self-correction 元数据
// 取最后一次连续的中文段落（超过 100 字且中文字符密度 > 70%）作为干净正文
function cleanChapterContent(text) {
  if (!text) return text;
  // qwen3.6-35b-a3b 输出模式：
  //   - thinking 文本 + 英文自评
  //   - 草稿答案（被自评包裹）
  //   - 真正章节正文（重复输出一遍）
  // 策略：按行扫描，仅保留「中文字符密度 >= 80% 且长度 >= 100 字」的行
  // 合并连续合格行作为最终正文。
  // 这样会跳过 thinking/英文自评，只保留真正的小说正文。

  const lines = text.split(/\r?\n/);
  const goodLines = [];
  let consecutive = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      consecutive = 0;
      continue;
    }
    const chineseChars = (trimmed.match(/[\u4e00-\u9fa5]/g) || []).length;
    const ratio = chineseChars / trimmed.length;
    // 阈值：70% 以上中文，且行总长 >= 20 字
    if (ratio >= 0.7 && trimmed.length >= 20) {
      goodLines.push(trimmed);
      consecutive++;
    } else {
      // 遇到不达标行：如果已有合格连续段就收尾
      if (goodLines.length > 0 && consecutive > 0) {
        // 间隔充许，但重置连续计数
        consecutive = 0;
      }
    }
  }

  const result = goodLines.join('\n');
  if (result.length < 100) return text.trim(); // 太短回暖原始
  return result;
}

// 续写章节：thinking 模型撞 max_tokens 后字数不足时调用
// 传入已写好的正文，请求接着写后续内容，直到达到目标字数
async function continueChapter(project, chapterNum, currentContent, targetWords, settingsObj) {
  let result = currentContent;
  let attempts = 0;
  const maxAttempts = 3;
  while (result.length < targetWords * 0.9 && attempts < maxAttempts) {
    attempts++;
    const remaining = targetWords - result.length;
    info(`续写第 ${attempts}/${maxAttempts} 次，还需 ≈${remaining} 字`);
    const tail = result.slice(-200); // 最近 200 字作为衔接
    const system = `你是专业网文作者。继续撰写小说正文，不要复述、重写、总结已完成部分，直接续写。`;
    const user = `上一段结尾：
${tail}

请直接续写下一段（约 ${Math.min(6000, Math.ceil(remaining * 3.5))} tokens、${remaining} 字中文以上），保持相同语气和人物。`;

    let extra;
    try {
      extra = await chat(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        settingsObj,
        { temperature: 0.85, maxTokens: Math.max(8192, Math.ceil(remaining * 3.5)), timeout: 600000 }
      );
    } catch (e) {
      warn(`续写失败: ${e.message.slice(0, 100)}`);
      break;
    }
    const cleaned = cleanChapterContent(extra);
    if (cleaned.length < 100) {
      warn('续写产物不足 100 字，中止');
      break;
    }
    result += '\n\n' + cleaned;
    info(`续写后总字数: ${result.length}`);
  }
  return result;
}

// 标题补全：检测「第 N 章」偷懒模式，用 LLM 重新生成标题
async function fixLazyTitles(projectId, settingsObj) {
  const chapters = db.listChapters(projectId);
  const lazy = chapters.filter((c) => /^第[\s一-十百零\d]+章(（完）)?$/.test(c.title || ''));
  if (lazy.length === 0) return 0;
  info(`检测到 ${lazy.length} 章标题偷懒，补全中...`);
  let fixed = 0;
  for (const ch of lazy) {
    if (!ch.summary || ch.summary === '待细化') continue;
    const prompt = `根据章节剧情要点，生成一个 4-12 字的独特章节标题。
要求：吸引人、不与现有章节标题重复、贴合剧情。
剧情：${ch.summary}
只输出新标题，不要引号、不要解释。`;
    try {
      const newTitle = (await chat(
        [{ role: 'user', content: prompt }],
        settingsObj,
        { temperature: 0.9, maxTokens: 30, timeout: 30000 }
      )).trim().split(/[\n\r]/)[0].replace(/^["「]|["」]$/g, '').slice(0, 16);
      if (newTitle && newTitle !== ch.title) {
        db.updateChapter(projectId, ch.chapter_num, { title: newTitle });
        fixed++;
      }
    } catch { /* 忽略单项失败 */ }
  }
  return fixed;
}

async function cmdConfig() {
  head('配置 LLM 连接');
  const current = loadSettings();
  const prompt = (label, key, placeholder = '') => {
    const def = current[key] || '';
    const hint = def ? `${C.dim}(当前: ${def.slice(0, 8)}***)${C.reset}` : `${C.dim}(留空: ${placeholder})${C.reset}`;
    process.stdout.write(`${label} ${hint}: `);
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (d) => {
        buf = d.toString().trim();
        resolve(buf);
      });
    });
  };

  // 简单 stdin 处理：用 readline 模式
  if (!process.stdin.isTTY) {
    err('config 需要交互式终端（TTY）');
    info('请手动设置环境变量或在 TTY 下运行 xiaoshuo config');
    return;
  }
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const baseUrl = (await rl.question(`接口地址 (当前: ${current.base_url || '未设置'}): `)).trim() || current.base_url;
  const apiKeyRaw = (await rl.question(`API Key (当前: ${current.api_key ? '已设置' : '未设置'}): `)).trim();
  const apiKey = apiKeyRaw || current.api_key || '';
  const model = (await rl.question(`模型名 (当前: ${current.model || 'gpt-4o-mini'}): `)).trim() || current.model || 'gpt-4o-mini';
  const temperature = (await rl.question(`温度 (当前: ${current.temperature || '0.85'}): `)).trim() || current.temperature || '0.85';
  const maxTokens = (await rl.question(`max_tokens (当前: ${current.max_tokens || '4096'}): `)).trim() || current.max_tokens || '4096';

  rl.close();

  const next = { base_url: baseUrl, api_key: apiKey, model, temperature, max_tokens: maxTokens };
  for (const [k, v] of Object.entries(next)) db.setSetting(k, String(v));

  ok('配置已保存到 SQLite');

  // 测试连接
  const test = await chat(
    [{ role: 'user', content: 'ping' }],
    next,
    { maxTokens: 16, timeout: 30000 }
  ).then((r) => r).catch((e) => null);

  if (test) ok(`测试连接成功，模型返回: ${C.dim}${JSON.stringify(test).slice(0, 80)}${C.reset}`);
  else warn('测试连接失败，请检查配置');
}

// ──────────────────────────── 列表 / 显示 ────────────────────────────

function cmdList() {
  const projects = db.listProjects();
  if (projects.length === 0) {
    info('还没有作品。运行 `xiaoshuo new` 创建一个。');
    return;
  }
  head(`作品列表（${projects.length} 部）`);
  const w = [4, 30, 12, 10, 14, 20];
  console.log(
    `${C.dim}#  ${'ID'.padEnd(w[0])} ${'标题'.padEnd(w[1])} ${'类型'.padEnd(w[2])} ${'章数'.padEnd(w[3])} ${'状态'.padEnd(w[4])} ${'更新时间'.padEnd(w[5])}${C.reset}`
  );
  projects.forEach((p, i) => {
    const idShort = p.id.slice(0, 8);
    console.log(`${String(i + 1).padEnd(2)} ${idShort.padEnd(w[0])} ${(p.title || '').slice(0, 28).padEnd(w[1])} ${(p.genre || '').padEnd(w[2] - 2)}  ${String(p.chapter_count).padEnd(w[3] - 2)}  ${(p.status || '').padEnd(w[4] - 2)}  ${(p.updated_at || '').padEnd(w[5])}`);
    console.log(`${C.dim}   full id: ${p.id}${C.reset}`);
  });
}

function findProject(id) {
  const all = db.listProjects();
  const found = all.find((p) => p.id === id || p.id.startsWith(id));
  // 拿完整对象（含 outline_json / characters_json 等大字段），listProjects 不返回这些列。
  return found ? db.getProject(found.id) : db.getProject(id);
}

function cmdShow(id) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  head(`作品详情: 《${project.title}》`);

  // 阶段进度条：6 个 phase（draft / planning / planning_failed / ready / writing / completed）
  const progress = phaseProgress(project.status);
  const phaseLabels = STATES.map((s, i) => {
    const icon = i < progress ? `${C.green}✓${C.reset}` : i === progress ? `${C.yellow}●${C.reset}` : `${C.dim}○${C.reset}`;
    return `${icon}${s}`;
  });
  console.log(`  ${C.dim}阶段进度:${C.reset} ${phaseLabels.join(' ')}`);
  const desc = describeState(project.status);
  console.log(`  ${C.dim}当前阶段:${C.reset} ${C.bold}${project.status}${C.reset} — ${desc.label} | ${C.dim}${desc.next}${C.reset}`);

  const fields = [
    ['ID', project.id],
    ['类型', project.genre],
    ['主题', project.theme],
    ['章数', project.chapter_count],
    ['每章字数', project.words_per_chapter],
    ['文风', project.style],
    ['状态', project.status],
    ['参考作品', project.reference_project_id || '(无)'],
    ['参考模式', project.reference_mode || '(无)'],
    ['全局摘要长度', (project.global_summary || '').length + ' 字'],
    ['创建时间', project.created_at],
    ['更新时间', project.updated_at],
  ];
  fields.forEach(([k, v]) => console.log(`  ${C.dim}${k}:${C.reset} ${v}`));

  const chapters = db.listChapters(project.id);
  console.log(`\n${C.bold}章节进度（${chapters.length} 章）${C.reset}`);
  if (chapters.length === 0) info('  还没有章节');
  else {
    chapters.forEach((c) => {
      const icon = c.status === 'done' ? `${C.green}✓${C.reset}` : c.status === 'writing' ? `${C.yellow}…${C.reset}` : `${C.dim}○${C.reset}`;
      const len = (c.content || '').length;
      console.log(`  ${icon} 第${c.chapter_num}章 ${c.title || '(无标题)'}  ${C.dim}${len}字${C.reset}`);
    });
  }
}

// ──────────────────────────── 新建 ────────────────────────────

async function cmdNew(flags) {
  head('新建作品');
  const hasAll = flags.t && flags.g && flags.c;
  const isInteractive = process.stdin.isTTY && !hasAll;
  let title, genre, theme, chapterCount, wordsPerChapter, style, extra;

  if (!isInteractive) {
    // 命令行参数或非 TTY 模式
    title = flags.t || flags.title || '未命名小说';
    genre = flags.g || flags.genre || '玄幻';
    theme = flags.theme || `${genre}题材`;
    chapterCount = Number(flags.c || flags.chapters || 30);
    wordsPerChapter = Number(flags.w || flags.words || 2000);
    style = flags.s || flags.style || '通俗流畅';
    extra = flags.extra || flags.e || flags.prompt || '';
  } else {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = async (label, def = '') => {
      const v = (await rl.question(`${label}${def ? ` ${C.dim}(默认: ${def})${C.reset}: ` : ': '}`)).trim();
      return v || def;
    };

    title = flags.t || flags.title || (await ask('书名', '未命名小说'));
    genre = flags.g || flags.genre || (await ask('类型 (玄幻/都市/科幻...)', '玄幻'));
    theme = flags.theme || (await ask('主题/核心卖点', `${genre}题材`));
    chapterCount = Number(flags.c || flags.chapters || (await ask('总章数', '30')));
    wordsPerChapter = Number(flags.w || flags.words || (await ask('每章字数', '2000')));
    style = flags.s || flags.style || (await ask('文风 (冷峻/轻松/诗意...)', '通俗流畅'));
    extra = await ask('附加设定 (可空)', '');
    rl.close();
  }

  const project = db.createProject({
    id: uuid(),
    title,
    genre,
    theme,
    chapter_count: chapterCount,
    words_per_chapter: wordsPerChapter,
    style,
    extra_prompt: extra,
    status: 'draft',
  });
  ok(`已创建作品《${title}》`);
  info(`ID: ${project.id}`);
  info(`下一步: xiaoshuo outline ${project.id.slice(0, 8)}`);
}

// ──────────────────────────── 大纲生成 ────────────────────────────

async function runOutlineJob(jobId, settingsObj) {
  const job = db.getGenerationJob(jobId);
  const project = db.getProject(job.project_id);
  const totalBatches = job.total_batches;

  info(`开始生成大纲，共 ${totalBatches} 批次`);

  let checkpoint = {};
  try { checkpoint = JSON.parse(job.checkpoint_json || '{}'); } catch {}

  try {
    const outline = await generateOutline(project, settingsObj, {
      checkpoint,
      onPlan: (plan) => {
        checkpoint = { plan, chapters: [] };
        db.updateGenerationJob(jobId, {
          completed_batches: 1,
          current_batch: 2,
          checkpoint_json: JSON.stringify(checkpoint),
        });
        process.stdout.write(`${C.dim}  [规划完成]${C.reset}`);
      },
      onBatch: ({ plan, chapters, completedBatches, totalBatches: tb }) => {
        checkpoint = { plan, chapters };
        db.updateGenerationJob(jobId, {
          total_batches: tb,
          completed_batches: completedBatches,
          current_batch: Math.min(tb, completedBatches + 1),
          checkpoint_json: JSON.stringify(checkpoint),
        });
        process.stdout.write(`\r${C.green}  [批次 ${completedBatches}/${tb}] 完成${C.reset}                    `);
      },
    });

    // 落库完整 outline（内联实现，避免 import index.js 启动 express）
    const normalized = {
      title_suggestion: outline.title_suggestion || project.title,
      world: outline.world || {},
      characters: Array.isArray(outline.characters) ? outline.characters : [],
      timeline: Array.isArray(outline.timeline) ? outline.timeline : [],
      plot: outline.plot || {},
      chapters: Array.isArray(outline.chapters) ? outline.chapters : [],
    };
    if (normalized.chapters.length !== project.chapter_count) {
      db.updateGenerationJob(jobId, { status: 'failed', error: `章节数 ${normalized.chapters.length} ≠ ${project.chapter_count}` });
      return err(`章节数不匹配: ${normalized.chapters.length} ≠ ${project.chapter_count}`);
    }
    normalized.chapters = normalized.chapters.map((chapter, index) => ({
      ...chapter,
      num: index + 1,
      title: String(chapter.title || `第${index + 1}章`).trim(),
      summary: String(chapter.summary || '').trim(),
    }));
    db.updateProject(project.id, {
      outline_json: JSON.stringify(normalized),
      characters_json: JSON.stringify(normalized.characters),
      timeline_json: JSON.stringify(normalized.timeline),
      plot_json: JSON.stringify(normalized.plot),
      world_json: JSON.stringify(normalized.world),
      status: 'ready',
    });
    // 写每章的 chapters 行（这是原 saveOutline 最重要的一步）
    for (const chapter of normalized.chapters) {
      const existing = db.getChapter(project.id, chapter.num);
      db.upsertChapter({
        id: existing?.id || uuid(),
        project_id: project.id,
        chapter_num: chapter.num,
        title: chapter.title,
        outline: chapter.summary,
        content: existing?.content || '',
        summary: existing?.summary || '',
        status: existing?.status || 'pending',
      });
    }

    db.updateGenerationJob(jobId, {
      status: 'done',
      completed_batches: totalBatches,
      current_batch: totalBatches,
      error: '',
      checkpoint_json: JSON.stringify({ plan: checkpoint.plan, chapters: outline.chapters }),
    });
    process.stdout.write('\n');
    ok('大纲生成完毕');
  } catch (e) {
    db.updateGenerationJob(jobId, { status: 'failed', error: String(e.message || e) });
    db.updateProject(project.id, { status: 'planning_failed' });
    err(`生成失败: ${e.message}`);
    warn(`可运行 xiaoshuo outline ${project.id.slice(0, 8)} 重试`);
  }
}

async function cmdOutline(id) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  if (project.status === 'writing' || project.status === 'completed') {
    return warn('已开始写作，不能重新生成全书大纲');
  }
  const settingsObj = loadSettings();
  const totalBatches = getOutlineBatchCount(project.chapter_count);
  const job = db.createGenerationJob({
    id: uuid(),
    project_id: project.id,
    job_type: 'outline',
    status: 'running',
    total_batches: totalBatches,
    completed_batches: 0,
    current_batch: 1,
    error: '',
    checkpoint_json: '{}',
  });
  db.updateProject(project.id, { status: 'planning' });
  await runOutlineJob(job.id, settingsObj);

  // 跑完打印大纲摘要
  const updated = db.getProject(project.id);
  if (updated.outline_json) {
    const outline = JSON.parse(updated.outline_json);
    head('大纲已生成');
    if (outline.title_suggestion) info(`建议书名: ${outline.title_suggestion}`);
    if (outline.plot?.premise) info(`核心卖点: ${outline.plot.premise}`);
    if (outline.chapters) info(`章节数: ${outline.chapters.length}`);

    // 检测并补全标题偷懒
    const fixed = await fixLazyTitles(project.id, settingsObj);
    if (fixed > 0) ok(`已补全 ${fixed} 章偷懒标题`);

    info(`✓ 已进入可写作状态，可直接运行 xiaoshuo write <id> <章号>`);
  }
}

// ──────────────────────────── 写作 ────────────────────────────

async function cmdWrite(id, num) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  const chapter = db.getChapter(project.id, Number(num));
  if (!chapter) return err(`第 ${num} 章不存在，请先生成大纲`);

  // 状态机预检：进入写作必须已准备好（outline 完成 或 正在写）
  // 使用 canTransition 而不是硬编码 ready/writing——状态机代码以后改、调用点自动跟着动。
  if (!canTransitionToWrite(project.status)) {
    const desc = describeState(project.status);
    return warn(`作品状态为 ${project.status}（${desc.label}），请先运行 xiaoshuo outline 生成大纲`);
  }

  const settingsObj = loadSettings();

  // 检查前序章节
  const prev = db.listChapters(project.id).find((c) => c.chapter_num < Number(num) && c.status !== 'done');
  if (prev) return warn(`请先完成第 ${prev.chapter_num} 章`);

  head(`写作: 《${project.title}》 第 ${num} 章`);
  db.updateProject(project.id, { status: 'writing' });
  db.updateChapter(project.id, Number(num), { status: 'writing', content: '' });

  // 检测 thinking 模型：qwen3.6 / 类似的会把推理与正文一起吐
// 后续 cleanChapterContent 才能可靠拿到干净正文
// 所以默认走非流式（避免流式中途网络抖动导致 0 字污染）
const isThinkingModel = (() => {
  try { return loadSettings().model?.includes('qwen3.6'); } catch { return false; }
})();
const stream = isThinkingModel
  ? null  // thinking 走非流式
  : await writeChapter(project, Number(num), settingsObj, { stream: true });
let content = '';
let lastPrint = 0;
process.stdout.write(`${C.dim}（${isThinkingModel ? '非流式（thinking 模型）' : '流式'}生成中...）${C.reset}\n\n`);
if (stream) {
  for await (const delta of stream) {
    content += delta;
    if (content.length - lastPrint > 800) {
      process.stdout.write(delta);
      lastPrint = content.length;
    }
  }
  if (content.length > lastPrint) {
    process.stdout.write(content.slice(lastPrint));
  }
} else {
  content = await writeChapter(project, Number(num), settingsObj, { stream: false });
  process.stdout.write(content.slice(0, 300));
  if (content.length > 300) process.stdout.write(`\n[...省略 \${content.length - 300} 字...]\n`);
}
process.stdout.write('\n\n');

  // 后处理：thinking 模型（如 qwen3.6）会在正文后输出 self-correction 元数据
  // 截取最后一次连续的「干净中文段落」（>100 字）
  let cleaned = cleanChapterContent(content);
  if (cleaned.length !== content.length) {
    warn(`原句 ${content.length} 字 → 净化后 ${cleaned.length} 字（去 ${content.length - cleaned.length} 字元数据）`);
  }

  // 续写保底：thinking 模型撞 max_tokens 后正文可能严重不足
  // 如果净化后不足目标字数的 70%，自动续写
  const target = project.words_per_chapter || 2000;
  if (cleaned.length < target * 0.7) {
    warn(`正文 ${cleaned.length} 字不足目标 ${target} 字×70%=${Math.floor(target * 0.7)}，触发续写`);
    cleaned = await continueChapter(project, num, cleaned, target, settingsObj);
    ok(`续写后 ${cleaned.length} 字`);
  }

  db.updateChapter(project.id, Number(num), { content: cleaned, status: 'summarizing' });
  ok(`正文已落盘（${cleaned.length} 字）`);
  info('生成摘要与记忆...');

  try {
    const memory = await afterChapterWritten(project.id, Number(num), settingsObj);
    ok(`摘要完成（${memory.summary.length} 字，${memory.memoryCount} 条记忆）`);
    const done = db.listChapters(project.id).filter((c) => c.status === 'done').length;
    if (done === project.chapter_count) {
      db.updateProject(project.id, { status: 'completed' });
      ok('🎉 全部章节完成！运行 `xiaoshuo export <id>` 导出');
    } else {
      info(`进度: ${done}/${project.chapter_count} 章`);
    }
  } catch (e) {
    err(`摘要生成失败: ${e.message}`);
    warn(`章节已标记为 generated，运行 xiaoshuo finalize ${id} ${num} 重试摘要`);
  }
}

async function cmdContinue(id, startNum) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  const settingsObj = loadSettings();

  const chapters = db.listChapters(project.id);
  const start = startNum
    ? Number(startNum)
    : (chapters.find((c) => c.status !== 'done')?.chapter_num ?? chapters.length + 1);

  for (let n = start; n <= project.chapter_count; n++) {
    await cmdWrite(id, n);
  }
}

async function cmdFinalize(id, num) {
  const settingsObj = loadSettings();
  info(`重新整理第 ${num} 章摘要...`);
  const memory = await afterChapterWritten(id, Number(num), settingsObj);
  ok(`完成（${memory.memoryCount} 条记忆）`);
}

async function cmdRegenerate(id, startChapter, newCount, instruction) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  const settingsObj = loadSettings();
  info(`重规划第 ${startChapter} 章起的后续大纲...`);
  await regenerateContinuationOutline(project, Number(startChapter), Number(newCount), instruction, settingsObj);
  ok('重规划完成');
}

// ──────────────────────────── 衍生 ────────────────────────────

async function cmdDerive(sourceId, mode) {
  const source = findProject(sourceId);
  if (!source) return err(`未找到源作品: ${sourceId}`);
  const settingsObj = loadSettings();

  let title, instruction;
  if (!process.stdin.isTTY) {
    title = flags.title || `${source.title}（续）`;
    instruction = flags.instruction || '';
  } else {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    title = (await rl.question(`新书名 (回车=续作同名): `)).trim() || `${source.title}（续）`;
    instruction = mode === 'template'
      ? ''
      : await rl.question('续作方向/要求（可空）: ');
    rl.close();
  }

  const newId = uuid();
  const chapters = db.listChapters(source.id);
  const newCount = source.chapter_count;

  db.createProject({
    id: newId,
    title,
    genre: mode === 'template' ? source.genre : source.genre,
    theme: mode === 'template' ? source.theme : `${source.theme}（续）`,
    chapter_count: newCount,
    words_per_chapter: source.words_per_chapter,
    style: source.style,
    extra_prompt: instruction,
    status: 'draft',
    reference_project_id: mode === 'sequel' ? source.id : '',
    reference_mode: mode === 'sequel' ? 'comprehensive' : '',
  });

  ok(`衍生作品已创建: 《${title}》`);
  info(`ID: ${newId}`);
}

// ──────────────────────────── 导出 / 删除 ────────────────────────────

function cmdExport(id) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  const chapters = db.listChapters(project.id).filter((c) => c.content);
  const body = chapters
    .map((c) => `第${c.chapter_num}章 ${c.title}\n\n${c.content}`)
    .join('\n\n\n');
  // 只把内容写到 stdout，进度提示走 stderr（避免污染管道）
  process.stdout.write(`《${project.title}》\n\n${body}`);
  process.stderr.write(`${C.blue}ℹ${C.reset} 已输出 ${chapters.length} 章，共 ${body.length} 字到 stdout\n`);
}

function cmdDelete(id) {
  const project = findProject(id);
  if (!project) return err(`未找到作品: ${id}`);
  db.deleteProject(project.id);
  ok(`已删除《${project.title}》`);
}

// ──────────────────────────── 主入口 ────────────────────────────

async function main() {
  const { cmd, positional, flags } = parseArgs(process.argv);

  try {
    switch (cmd) {
      case 'list':
      case 'ls':
        cmdList(); break;
      case 'config':
      case 'cfg':
        await cmdConfig(); break;
      case 'new':
      case 'create':
        await cmdNew(flags); break;
      case 'show':
      case 'view':
        if (!positional[0]) return usage();
        cmdShow(positional[0]); break;
      case 'outline':
        if (!positional[0]) return usage();
        await cmdOutline(positional[0]); break;
      case 'outline-confirm':
        if (!positional[0]) return usage();
        {
          // 纯校验：检查大纲是否已生成。不再改 status（现在 outline 完成自动切 ready）。
          // 保留这个命令是向后兼容老用户 / 也可手动补调。
          const project = findProject(positional[0]);
          if (!project) return err(`未找到作品: ${positional[0]}`);
          if (project.outline_json) {
            ok(`《${project.title}》大纲已就绪（状态: ${project.status}），可直接运行 xiaoshuo write`);
          } else {
            return warn(`《${project.title}》尚未生成大纲，请先运行 xiaoshuo outline ${project.id.slice(0, 8)}`);
          }
        }
        break;
      case 'write':
        if (!positional[0] || !positional[1]) return usage();
        await cmdWrite(positional[0], positional[1]); break;
      case 'continue':
      case 'cont':
        if (!positional[0]) return usage();
        await cmdContinue(positional[0], positional[1]); break;
      case 'finalize':
        if (!positional[0] || !positional[1]) return usage();
        await cmdFinalize(positional[0], positional[1]); break;
      case 'regenerate':
        if (!positional[0] || !positional[1] || !positional[2]) return usage();
        await cmdRegenerate(positional[0], positional[1], positional[2], flags.instruction || ''); break;
      case 'derive':
        if (!positional[0]) return usage();
        await cmdDerive(positional[0], flags.mode || 'sequel'); break;
      case 'export':
        if (!positional[0]) return usage();
        cmdExport(positional[0]); break;
      case 'delete':
      case 'rm':
        if (!positional[0]) return usage();
        cmdDelete(positional[0]); break;
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        usage(); break;
      default:
        err(`未知命令: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (e) {
    err(`错误: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
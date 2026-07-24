# xiaoshuo-cli

> 基于 [TvTink/xiaoshuo](https://cnb.cool/TvTink/xiaoshuo) 的命令行入口，
> 提供无浏览器环境下的长篇小说生成体验。
> 所有 LLM 调度、上下文记忆、SQLite 持久化逻辑 100% 沿用原作者实现。

---

## 关于本项目

本项目是 [墨线 · 小说工坊](https://cnb.cool/TvTink/xiaoshuo) 的 CLI 改造版本，作者：[浪疯Koru](https://cnb.cool/MGS_CRAZY)。

原项目是一个本地运行的网页版长篇小说生成器，本仓库在不修改原作者任何后端代码的前提下，新增了一个 Node.js CLI 入口，复用所有 `server/*.js` 模块：

- `server/llm.js` — OpenAI 兼容 LLM 客户端
- `server/context.js` — 上下文管理（4 层滚动记忆 + 全局摘要 + 断点续传）
- `server/db.js` — SQLite 持久化

适用场景：
- 服务器 / 远程主机无浏览器
- 喜欢纯命令行工作流
- 想批量跑生成任务（cron / 脚本）

## 安装

```bash
git clone https://github.com/<your-name>/xiaoshuo-cli.git
cd xiaoshuo-cli
npm install
npm link              # 注册 `xiaoshuo` 全局命令
```

## 配置

```bash
xiaoshuo config
```

按提示填入：
- 接口地址（如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、Ollama `http://localhost:11434/v1`）
- API Key（本地 Ollama 可留空）
- 模型名（如 `gpt-4o-mini`、`deepseek-chat`）
- 温度 / max_tokens

配置保存在本地 SQLite `data/novels.db` 的 `settings` 表里。

## 使用

```bash
xiaoshuo list                                # 列出所有作品
xiaoshuo new -t "剑破苍穹" -g 玄幻 -c 100 -e "主角是..."  # 新建作品（含附加设定）
xiaoshuo show <id>                           # 查看详情
xiaoshuo outline <id>                        # 生成大纲（异步轮询进度）
xiaoshuo outline-confirm <id>                # 确认大纲，进入可写作状态
xiaoshuo write <id> 1                        # 写第 1 章（流式打印）
xiaoshuo continue <id>                       # 连续写完剩余章节
xiaoshuo regenerate <id> <起始章> <新章数>   # 重规划后续大纲
xiaoshuo derive <id> --mode sequel           # 衍生续作
xiaoshuo derive <id> --mode template         # 复用模板
xiaoshuo export <id> > 《剑破苍穹》.txt      # 导出 TXT
xiaoshuo delete <id>                         # 删除作品
```

## 写作流程（与原网页版一致）

1. 输入书名 / 类型 / 主题 / 章数 / 每章字数 / 文风 / **附加设定（`-e`）**
2. 生成世界设定、主要人物、时间线、大体剧情与逐章大纲
3. 确认大纲后进入写作台
4. 逐章生成或连续写作
5. 完成后导出 TXT

### `-e` 附加设定用法

`-e` / `--extra` / `--prompt` 三种写法等价，把完整创意 prompt 传给 LLM：

```bash
xiaoshuo new -t "秘卷的短途" -g 东方玄幻 -c 3 \
  -e "主角是一只成了精的白猫，住在现代上海，会写 Python 脚本，
      一次接单遇到用易经 64 卦写的祖传代码。"
```

不传 `-e` 时，模型按 genre/theme 模板自由发挥；传了之后 LLM 会按 prompt 走。

## 核心特性（沿用原作者）

- ✅ 单部作品最多 1000 章
- ✅ 超过 10 章自动按 10 章/批生成大纲，断点续传（README 之前误写"50/20"已修正）
- ✅ 模型返回 JSON 自动修复（`jsonrepair` 兜底）
- ✅ 4 层滚动记忆（全局摘要 / 最近摘要 / 章末原文 / 结构化记忆）
- ✅ 流式 SSE 输出（SSE → CLI 实时打印）
- ✅ 衍生创作：续作 / 复用模板
- ✅ 重规划后续大纲

## 数据库

数据库文件位于 `data/novels.db`（首次运行时自动创建）。**请勿将该目录提交或分享**，里面包含你的所有作品正文和 API Key。

## 致谢

- 原作者：[浪疯Koru](https://cnb.cool/MGS_CRAZY) / [TvTink/xiaoshuo](https://cnb.cool/TvTink/xiaoshuo)
- License：MIT（与原项目一致）

## 免责声明

本项目为个人工具 fork，仅供本地学习使用。请勿用于：
- 生成违反法律法规的内容
- 商业用途（未获得原作者授权）
- 任何侵犯他人权益的场景
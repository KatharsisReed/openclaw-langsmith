# GitHub 面试作品准备清单

最后更新: 2026-04-23

## 当前结论

这个仓库已经完成了第一轮 GitHub 化整理，当前状态适合继续往“可展示作品仓库”推进。基础包装、测试闭环和 CI 都已经补上，剩下的主要是两个需要你明确的信息或授权的事项：

- 真实的 GitHub 仓库元数据还没有来源，暂时不能安全写入 `package.json`
- 根目录 4 个 `.tar.gz` 备份文件还没有删除，我没有在未确认的情况下做破坏性操作

## 一、已完成

### 1.1 仓库包装

- [x] 创建 `README.md`
  - [x] 项目简介
  - [x] 中英双语摘要
  - [x] 核心功能说明
  - [x] 安装与构建命令
  - [x] 快速开始配置示例
  - [x] 配置说明
  - [x] 架构文档链接
  - [x] 贡献说明
  - [x] License 说明

- [x] 添加 `LICENSE` 文件
  - [x] 使用 MIT License
  - [x] 在 `package.json` 中添加 `license`

- [x] 更新 `package.json`
  - [x] 补充 `license`
  - [x] 扩充 `keywords`
  - [x] 添加 `test` / `test:build` / `test:run` / `test:coverage` 脚本

- [x] 更新 `.gitignore`
  - [x] 添加 `.pnpm-store/`
  - [x] 添加 `*.tar.gz`
  - [x] 添加 `dist-test/`

### 1.2 安全与说明文档

- [x] 清理 `AGENTS.md` 中的敏感信息
  - [x] 删除服务器 IP / SSH 隧道命令
  - [x] 删除本地绝对路径
  - [x] 改写为通用开发说明

- [x] 更新 `CLAUDE.md`
  - [x] 补充 `src/handlers/transcript.ts`
  - [x] 说明当前实现为 6 个 hooks
  - [x] 更新 `before_message_write` 在追踪链路中的角色

- [x] 明确 `self-learn-src/` 的处理策略
  - [x] 当前决定为保留
  - [x] 已在 `README.md` 中说明其为原型参考目录

### 1.3 测试与自动化

- [x] 添加测试基础设施
  - [x] 新增 `tsconfig.test.json`
  - [x] 新增轻量测试运行器
  - [x] 支持本地 `corepack pnpm test`

- [x] 添加基础测试
  - [x] `test/config.test.ts`
  - [x] `test/tracer.test.ts`
  - [x] `test/handlers/llm.test.ts`
  - [x] `test/handlers/tool.test.ts`
  - [x] `test/handlers/agent.test.ts`
  - [x] `test/handlers/transcript.test.ts`

- [x] 添加 GitHub Actions
  - [x] `pnpm install`
  - [x] `pnpm check`
  - [x] `pnpm build`
  - [x] `pnpm test:coverage`
  - [x] 上传原始 V8 coverage 数据

### 1.4 已验证

- [x] `corepack pnpm check`
- [x] `corepack pnpm build`
- [x] `corepack pnpm test`

## 二、仍待处理

### 2.1 需要你提供真实信息的项

- [ ] 在 `package.json` 添加真实 `repository` 字段
- [ ] 在 `package.json` 添加真实 `homepage` 字段
- [ ] 在 `package.json` 添加真实 `bugs` 字段
- [ ] 决定是否添加 `author` 字段

说明：
- 这些字段都依赖你最终要公开的 GitHub 仓库地址和对外署名
- 在没有真实 URL 和署名之前，不建议写占位值

### 2.2 需要你确认后再执行的项

- [ ] 删除以下 4 个备份压缩包
  - `openclaw-langsmith-sync-20260419-2.tar.gz`
  - `openclaw-langsmith-sync-20260419-3.tar.gz`
  - `openclaw-langsmith-sync-20260419-4.tar.gz`
  - `openclaw-langsmith-sync-20260420-final-llm-fix.tar.gz`

说明：
- 这些文件已经被 `.gitignore` 覆盖，不会继续被纳入版本控制
- 但它们仍然存在于工作目录中，是否删除属于破坏性操作，需要你点头后再做

## 三、可选加分项

- [ ] 添加 `CONTRIBUTING.md`
- [ ] 添加 `CHANGELOG.md`
- [ ] 在 `README.md` 增加 badges
- [ ] 继续整理 `PRD.md` 和 `ARCHITECTURE.md` 的结构表达
- [ ] 将 coverage 从“原始 V8 数据”进一步升级为更直观的汇总报告

## 四、建议下一步

1. 先创建 GitHub 仓库，得到最终仓库 URL
2. 回填 `package.json` 的 `repository` / `homepage` / `bugs`
3. 确认是否删除 4 个备份压缩包
4. 如果还要继续打磨面试展示，再补 `CONTRIBUTING.md`、badges 和文档精修

# Code Agent Workspace UI 方案

[English](code-agent-workspace-ui-plan.md)

状态：Phase 6 已验收，历史方案完成
日期：2026-05-26
复核：2026-07-12

## 目标

把复用普通聊天界面过多的 Code Agent room，演进为真正的 coding-agent workspace：用户能提交代码任务、理解 run/tool 状态、查看和编辑文件、review diff、操作 terminal、预览服务与访问发布产物。

RoomTalk 继续拥有 room、user、permission、persistence、cost/model、E2B lifecycle 和移动/桌面 shell；Coco 或 Codex backend 拥有 agent loop 与工具语义。

## Code Agent 修改边界

如果 GUI 需要的是 runtime 本身应该提供的能力，可以修改 Code Agent engine；但 browser 永远不能直连 engine。唯一允许的控制路径是：

```text
Browser
  -> RoomTalk API / Socket.IO
  -> permission + audit
  -> sandbox runner protocol
  -> agent backend
```

RoomTalk 不应把 backend 内部事件原样泄漏给 UI，而应归一化为稳定的 text、tool、approval、usage、file/diff 和 terminal 状态。

## 设计决策

没有整体嵌入 T3 Code 或其他客户端。RoomTalk 吸收的是 developer workspace 的信息架构和交互模式，同时保留自己的 room collaboration、权限、多客户端一致性和移动端体验。

文案遵循紧凑、可翻译、面向动作的规则。用户看到的是 `Plan`、`Edit`、`Review changes`、`Terminal` 等产品概念，而不是内部类名或 runner implementation detail。

## 目标结构

```text
Code Agent room
  ├─ conversation and run timeline
  ├─ files / search / editor / preview
  ├─ Git changes / diff / review comments
  ├─ terminal sessions
  ├─ dev-server previews
  └─ published artifacts
```

桌面端使用并列/可折叠工作区，移动端通过明确的 view switching 避免同时挤压聊天与文件面板。

## Workspace Revision 边界

消息 retry 不自动等于文件 rewind。每个完成 turn 可以记录 workspace revision；只有显式 restore、权限校验和 sandbox 操作成功后，才改变工作区。UI 不能仅根据旧 message 内容推断当前文件状态。

Files/diff/terminal/preview 都由 server 获取当前 sandbox snapshot，并携带 revision/session identity，避免跨 reconnect 显示过期结果。

## 实施阶段

### Phase 0：源码与交互调研

核对 RoomTalk、Code Agent、Codex/T3 Code 的能力边界，定义哪些概念属于 UI、server 或 runtime。

### Phase 1：Workspace Shell

建立 Code Agent 专用 header、composer、run status、mode selector 和桌面/移动布局，不改变普通 chat room。

### Phase 2：通用前端模型

把 backend-specific event 转成稳定 view model，支持 text、reasoning、tool、approval、usage、error 与 terminal state。

### Phase 3：Backend Abstraction

让 UI 不依赖 Coco/Codex 私有事件，为后续 backend 选择和 app-server control 做准备。

### Phase 4：Workspace APIs

接入鉴权后的 snapshot、tree、file、search、diff、review、mutation、terminal 和 preview API；所有读取与写入重新检查 room access。

### Phase 5：吸收成熟 coding UI 模式

完善文件导航、diff 可读性、tool timeline、review comment、preview 与 responsive 交互，但不复制别的产品外壳。

### Phase 6：Codex Backend Spike

验证中立 frontend model 能承载第二 backend，并明确认证、session、approval、interrupt 与 sandbox 边界。

## UX 要求

- 当前运行、等待审批、已中断、失败和已完成必须可区分；
- Plan/read-only 与 Edit/write-capable mode 明确显示；
- 同一文件重复打开、snapshot 刷新和 diff 更新行为一致；
- terminal 与 preview 不遮蔽 room controls；
- 大文件、大 diff、二进制和 asset preview 有 bounded fallback；
- mobile 保留可达的 back、files、conversation 与 run controls；
- reconnect 后以 server/sandbox state 恢复，不依赖单一组件内存。

## 测试

覆盖 view-model reducer、socket ordering、permission failures、same-file reopen、large diff、terminal lifecycle、preview discovery、responsive navigation，以及真实 sandbox snapshot integration。

## 当前结果

计划中的 workspace 已落地，并继续扩展为 files/search/editing、asset preview、Git diff/review、PTY、dev-server browser preview 与 published artifacts。当前行为以 [运行时架构](code-agent-runtime-architecture.zh.md) 为准。

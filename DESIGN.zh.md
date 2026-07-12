# 受 Claude（Anthropic）启发的设计系统

[English](DESIGN.md)

状态：视觉参考，不是 RoomTalk 当前设计事实源
复核：2026-07-12

> 本文只用于语气、色彩、排版与间距灵感。RoomTalk 当前界面以 HeroUI、Tailwind 和 `client-heroui/src/components` 的实际实现为准。

## 1. 视觉主题与氛围

整体方向是温暖、克制、安静、有编辑感的数字工作空间。背景更像纸张而不是发光屏幕；标题具有书籍/杂志的节奏；强调色偏陶土、米色和低饱和绿色，避免常见 AI 产品的冷蓝、霓虹和过度未来感。

关键特征：

- 羊皮纸感画布 `#f5f4ed`；
- 标题使用 serif，UI 使用 sans，代码使用 mono；
- 陶土强调色 `#c96442`；
- 所有 neutral 带轻微黄褐/橄榄底色；
- 用有机插图和编辑式留白代替密集科技装饰；
- 以细 ring、浅阴影和层级间距表达深度。

## 2. 色板与角色

### Primary

- Near black `#141413`：主要文字、深色 surface；
- Terracotta `#c96442`：品牌强调、主要 action、选中态；
- Dark warm `#30302e`：次级深色 surface。

### Secondary / Accent

- Muted green：成功、自然感辅助色；
- Warm sand / ochre：提示与轻量 highlight；
- Soft coral：有限的交互强调，不做大面积背景。

### Surface

- Canvas `#f5f4ed`：页面背景；
- Elevated paper：比 canvas 稍亮的 card/modal；
- Warm border `#e8e6dc` / `#f0eee6`：低对比结构线；
- Dark surface 使用带橄榄感的黑灰，而不是纯黑。

### Text

- Primary：`#141413`；
- Secondary：`#5e5d59`；
- Muted：`#87867f`；
- Disabled 必须仍达到对应背景下的可读性要求。

### Semantic

Error、warning、success、info 都应在 warm palette 中保持足够对比。颜色不是唯一状态信号，还需文字、icon 或结构变化。

## 3. 字体规则

- Serif：营销标题、空状态大标题、叙事型段落入口；
- Sans：导航、按钮、表单、消息和高频操作；
- Mono：code、ID、terminal、快捷键和技术 metadata。

层级建议：

- Display：紧凑 line-height，大留白；
- Page title：清楚但不过度抢占 workspace；
- Section title：用 weight/spacing 建层级，不依赖全大写；
- Body：舒适行长与 1.5 左右 line-height；
- Label/caption：仍保持可读，不用极淡灰隐藏信息。

核心原则是少量明确层级、稳定节奏、内容优先。

## 4. 组件风格

### Button

- Primary：terracotta 或 near-black 实底，文字对比达到 WCAG AA；
- Secondary：paper surface + warm border；
- Ghost：无背景，hover/pressed 提供可见反馈；
- Destructive：明确红色语义与确认，不借用 primary 色；
- 紧凑控件可以小，但 touch target、focus ring 与 tooltip 不能缺失。

### Card / Container

Card 使用轻边界、适度圆角和很浅的 warm shadow。避免每一层都套 card；优先用 spacing 和 divider 表达区域。

### Input / Form

Input 保持纸面感 surface、清楚 border 与强 focus ring。Label 常驻，placeholder 不承担 label。错误靠近字段显示，并由辅助技术播报。

### Navigation

选中态通过文字 weight、背景和 indicator 组合表达。Desktop sidebar 适合高信息密度；mobile bottom navigation 保留最核心目的地。

### Image / Media

图片圆角与内容密度协调。Loading、failure、download/open state 都需要明确反馈；不能只用 icon 颜色变化。

### Distinctive Components

- Warm editorial hero / empty state；
- 消息与 tool timeline 的细微层级；
- 代码 workspace 使用更中性的 surface，避免装饰干扰 diff/terminal；
- 手绘感图形只用于低频叙事场景。

## 5. 布局原则

采用 4/8px 基础 spacing scale。常用间距保持可预测：控件内 8–12px、同组元素 12–16px、section 24–40px、大段落 48px 以上。

内容容器限制行长；workspace 可以全宽，但侧栏、对话和文件区域要有清晰 resize/collapse 规则。留白用于建立节奏，不是简单放大页面高度。

圆角从小控件到大 modal 逐级增大，避免所有元素使用同一夸张半径。

## 6. 深度与层级

优先使用：

1. 背景色差；
2. 1px warm border/ring；
3. 小范围柔和 shadow；
4. 仅 modal/popover 使用更强 elevation。

不要用厚重阴影包围每个 card，也不要通过多个渐变制造无意义层次。

## 7. 应做与不应做

应做：

- 使用 warm neutral 和一致 typography；
- 给内容充足呼吸空间；
- 保留明显 keyboard focus；
- 让 status、error 和 destructive action 可理解；
- 在 dark/light theme 中分别验证对比度；
- 用真实 RoomTalk 密度和多语言文案验证布局。

不应做：

- 复制 Anthropic 商标、字体资产或品牌插图；
- 大面积使用冷蓝/霓虹；
- 用 placeholder 代替 label；
- 为追求极简隐藏关键状态；
- 把所有文字都换成 serif；
- 让 mobile 只是 desktop 的缩小版。

## 8. 响应式行为

RoomTalk 主要 breakpoint 为 768px。Desktop 可使用 sidebar、多栏 workspace 与 persistent controls；mobile 使用单栏、bottom navigation、全屏 sheet/modal 与明确 view switch。

触控目标应易于命中，必要时让视觉图标保持紧凑但扩大 hit area。软键盘出现后 composer、send action 和当前输入仍必须可见；媒体按可用宽度缩放并保持手势边界。

## 9. 给 Agent 的提示模板

设计或修改组件时，应告诉 agent：

- 当前是 RoomTalk/HeroUI/Tailwind，不是重建 Claude 网站；
- 使用 warm paper surface、terracotta accent 和清晰 focus；
- 保持现有信息密度与 compact control；
- 同时覆盖 light/dark、English/中文、desktop/mobile；
- 复用现有 token/component，而不是加入孤立颜色；
- 通过 screenshot、accessibility name、keyboard 与 responsive viewport 验证。

示例：

> 在不改变交互流程的前提下，把这个空状态调整为温暖、编辑式的 RoomTalk 风格。复用现有 HeroUI/Tailwind token，保留 compact controls，验证中英文和 390px/1440px 视口。

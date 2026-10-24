# DeepSeek V4 适配优化方案

> Internal engineering record — kept in Chinese. English product docs: the user guide and release notes.

## 背景

Wukong CLI 通过 `packages/kosong/src/providers/openai-legacy.ts` 中的 `OpenAILegacyChatProvider`，走 OpenAI 兼容 Chat Completions 协议接入 DeepSeek V4。当前对 DeepSeek V4 的支持存在三个层面的不足：**模型能力识别缺失**、**reasoning_effort 参数兼容性错误**、**上下文窗口等默认值无感知**。

## 一、当前适配现状与定位

### 1.1 请求路径

用户配置（`config.toml` 或 `ENV`）→ `wukongConfig.models` → `ProviderManager.resolveProviderConfig(model)` → `toKosongProviderConfig()` → `createProvider(config)` → `OpenAILegacyChatProvider.generate()` → OpenAI SDK `chat.completions.create()`

关键文件:

| 角色 | 文件 |
|------|------|
| 配置 schema | `packages/agent-core/src/config/schema.ts` |
| 能力检测表 | `packages/kosong/src/providers/capability-registry.ts` |
| 能力查询入口 | `packages/kosong/src/providers/index.ts` (`getModelCapability`) |
| provider 构建 | `packages/agent-core/src/session/provider-manager.ts` (`toKosongProviderConfig`) |
| 请求生成 | `packages/kosong/src/providers/openai-legacy.ts` (`OpenAILegacyChatProvider.generate`) |
| 现有测试 | `packages/kosong/test/openai-legacy.test.ts`、`capability-providers.test.ts` 等 |

### 1.2 现有 DeepSeek 相关行为

| 功能 | 当前行为 | 是否正确 |
|------|---------|---------|
| `reasoning_content` 接收 | 默认扫描 `reasoning_content` `reasoning_details` `reasoning` 三个 key | ✅ |
| `reasoning_content` 回传 | 默认序列化为 `reasoning_content` | ✅ |
| `max_tokens` vs `max_completion_tokens` | DeepSeek 模型名不匹配 OpenAI o-/gpt-5 规则，走 `max_tokens` | ✅ |
| 模型能力识别 | `getOpenAILegacyModelCapability` 不匹配任何 DeepSeek 模型名，返回 `UNKNOWN_CAPABILITY` | ❌ |
| `reasoning_effort` 自动注入 | 历史含 ThinkPart 即注入 `reasoning_effort: medium`，不区分模型 | ❌ |
| `reasoning_effort` 显式注入 | `withThinking()` 直接下发 `reasoning_effort=xhigh/max`（测试已覆盖 DeepSeek） | ❌ |

## 二、DeepSeek V4 的 API 参数兼容性（关键差异）

| 参数/特性 | DeepSeek 原生 API | OpenAI o系列 | 结论 |
|-----------|------------------|-------------|------|
| 工具调用 | ✅ tools | ✅ | 能力检测应设 `tool_use: true` |
| 推理链 | ✅ `reasoning_content` | ✅ `reasoning_content` | 字段兼容，无需改动 |
| 图片输入 | ✅ 支持 | ❌ o系列不支持 | 能力检测应设 `image_in: true` |
| `reasoning_effort` 参数 | **❌ 不支持** | ✅ | 必须阻止 injection |
| `max_tokens` | ✅ | ✅ (但部分模型用 `max_completion_tokens`) | 无需改动 |
| 上下文窗口 | 128K | 200K+ | alias 需指定 |

**核心问题: `reasoning_effort` 不兼容**

DeepSeek 原生 API 不支持 `reasoning_effort` 参数。如果 Wukong 注入这个参数，DeepSeek API 会返回 400 错误。当前有两处注入行为:

1. `OpenAILegacyChatProvider.generate()` 中的**自动注入** —— 当历史消息包含 `ThinkPart` 时，自动注入 `reasoning_effort: medium`。
2. `withThinking()` 的**显式注入** —— 用户设置 thinking level → `reasoning_effort=xhigh/max`。

两处都需要处理: 自动注入必须跳过，显式注入至少不应静默通过；理想方案是 silent skip。

### 边界情况: 通过 OpenRouter 等网关访问

通过 OpenRouter 等网关访问时，API 可能接受 `reasoning_effort`（网关会 drop 掉）。但模型名可能是 `deepseek/deepseek-v4-pro`（斜杠分隔），需要同时匹配 `deepseek/` 和 `deepseek-` 前缀。

## 三、具体修改方案

### 3.1 能力识别: 在 `capability-registry.ts` 中添加 DeepSeek 模型族

文件: `packages/kosong/src/providers/capability-registry.ts`

**目标**: 让 `getModelCapability('openai', 'deepseek-v4')` 和 `getModelCapability('openai', 'deepseek-reasoner')` 返回正确的 `ModelCapability`。

**当前状态**: `OPENAI_LEGACY_CAPABILITY_CATALOG` 只匹配 OpenAI gpt/o 系列，未知模型返回 `UNKNOWN_CAPABILITY`（`tool_use=false`, `thinking=false` 等全部 false）。

**修改内容**:

```typescript
// 新增常量
const DEEPSEEK_V4_TOOL_THINKING_VISION_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

const DEEPSEEK_REASONER_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

// 在 OPENAI_LEGACY_CAPABILITY_CATALOG 中插入（优先级在 isOpenAIReasoningModel 之后）
{
  // DeepSeek V4 系列 (deepseek-v4, deepseek-v4-pro, deepseek-v4-flash, 含 openrouter 前缀)
  matches: (name) => name.includes('deepseek-v4'),
  capability: DEEPSEEK_V4_TOOL_THINKING_VISION_CAPABILITY,
},
{
  // DeepSeek R1 推理模型
  matches: (name) => name === 'deepseek-reasoner' || name.endsWith('/deepseek-reasoner'),
  capability: DEEPSEEK_REASONER_CAPABILITY,
},
// DeepSeek V3 / chat (纯 chat 模型，无 thinking，有 tool_use)
{
  matches: (name) => name === 'deepseek-chat' || name.endsWith('/deepseek-chat'),
  capability: { ...OPENAI_VISION_TOOL_CAPABILITY },
},
```

**匹配规则说明**:
- `deepseek-v4` 系列: `name.includes('deepseek-v4')` 可以同时匹配 `deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 等。
- R1: 精确匹配 `deepseek-reasoner` 或 `*/deepseek-reasoner`。
- V3/chat: 精确匹配 `deepseek-chat` 或 `*/deepseek-chat`。

**等效替代方案**: 只添加一个通用 DeepSeek 匹配 `name.includes('deepseek')`，返回最大能力集 V4 的能力。但这样对 R1 会错误设置 `image_in: true`。更推荐按模型细分。

### 3.2 阻止 `reasoning_effort` 注入

文件: `packages/kosong/src/providers/openai-legacy.ts`

#### 3.2.1 自动注入路径

**当前逻辑**（`generate()` 中，约 line 535-541）:

```typescript
if (reasoningEffort === undefined && kwargs['reasoning_effort'] === undefined) {
  const hasThinkPart = history.some((message) =>
    message.content.some((part) => part.type === 'think'),
  );
  if (hasThinkPart) {
    reasoningEffort = 'medium';
  }
}
```

**修改**: 在注入前判别模型是否兼容 `reasoning_effort`。

```typescript
if (
  reasoningEffort === undefined &&
  kwargs['reasoning_effort'] === undefined &&
  !isModelWithoutReasoningEffort(this._model)  // 新增判断
) {
  const hasThinkPart = history.some(...);
  if (hasThinkPart) {
    reasoningEffort = 'medium';
  }
}
```

`isModelWithoutReasoningEffort` 实现:

```typescript
function isModelWithoutReasoningEffort(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return lower.includes('deepseek');  // DeepSeek 全系列不支持
  // 未来可扩展: 加入 qwen 或其他不支持 reasoning_effort 的模型
}
```

#### 3.2.2 显式注入路径（`withThinking()`）

**当前逻辑**（`generate()` 中，约 line 568-570）:

```typescript
if (reasoningEffort !== undefined) {
  createParams['reasoning_effort'] = reasoningEffort;
}
```

**需要决策两种方案**:

| 方案 | 行为 | 优点 | 缺点 |
|------|------|------|------|
| A: 静默忽略 | DeepSeek 的 `withThinking()` 返回同样的 clone（thinkingEffort 照设，但 `generate()` 跳过 `reasoning_effort` 注入） | 不报错 | 用户不知道 thinking level 实际上无效 |
| B: 阻断报错 | DeepSeek 的 `withThinking()` 返回 no-op 或抛错误 | 用户明确知晓 | 可能破坏现有逻辑链 |

**推荐方案 A**（静默忽略）：因为 thinking level 对于 DeepSeek 本身就是无意义参数（DeepSeek 无法按 effort 调节推理强度），忽略最合理。修改点在 `generate()`:

```typescript
if (reasoningEffort !== undefined && !isModelWithoutReasoningEffort(this._model)) {
  createParams['reasoning_effort'] = reasoningEffort;
}
```

同时 `thinkingEffort` getter 保持原样（可以设置为 `null` 或保留值用于 UI 显示），但请求体中不发送。

### 3.3 文档和示例

#### 3.3.1 用户配置示例

在 `config.toml` 文档或 README 中给出 DeepSeek V4 完整配置:

```toml
[providers.deepseek]
type = "openai"
baseUrl = "https://api.deepseek.com"
apiKey = "${DEEPSEEK_API_KEY}"

[models.deepseek-v4]
provider = "deepseek"
model = "deepseek-v4"
maxContextSize = 128000
maxOutputSize = 8192
# capabilities 可以不声明，自动识别 tool_use / thinking / image_in

[models.deepseek-v4-pro]
provider = "deepseek"
model = "deepseek-v4-pro"
maxContextSize = 128000
maxOutputSize = 8192
```

#### 3.3.2 ENV 模式

```bash
export WUKONG_MODEL_NAME="deepseek-v4"
export WUKONG_MODEL_API_KEY="sk-xxx"
export WUKONG_MODEL_PROVIDER_TYPE="openai"
export WUKONG_MODEL_BASE_URL="https://api.deepseek.com"
export WUKONG_MODEL_MAX_CONTEXT_SIZE=128000
export WUKONG_MODEL_MAX_OUTPUT_SIZE=8192
export WUKONG_MODEL_CAPABILITIES="tool_use,thinking,image_in"
```

### 3.4 测试用例补充

#### 3.4.1 能力检测测试

文件: `packages/kosong/test/capability-providers.test.ts`

```typescript
describe('getModelCapability: openai (DeepSeek)', () => {
  it('deepseek-v4 → image_in + thinking + tool_use', () => {
    const cap = getModelCapability('openai', 'deepseek-v4');
    expect(cap.image_in).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
  });

  it('deepseek-v4-pro → same as v4', () => {
    const cap = getModelCapability('openai', 'deepseek-v4-pro');
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.image_in).toBe(true);
  });

  it('openrouter-prefixed deepseek-v4 → still recognized', () => {
    const cap = getModelCapability('openai', 'deepseek/deepseek-v4-pro');
    expect(cap.thinking).toBe(true);
  });

  it('deepseek-reasoner → thinking + tool_use, image_in=false', () => {
    const cap = getModelCapability('openai', 'deepseek-reasoner');
    expect(cap.thinking).toBe(true);
    expect(cap.tool_use).toBe(true);
    expect(cap.image_in).toBe(false);
  });

  it('deepseek-chat → tool_use, thinking=false, image_in=true', () => {
    const cap = getModelCapability('openai', 'deepseek-chat');
    expect(cap.tool_use).toBe(true);
    expect(cap.thinking).toBe(false);
    expect(cap.image_in).toBe(true);
  });

  it('unknown model → UNKNOWN_CAPABILITY', () => {
    expect(getModelCapability('openai', 'fake-model')).toEqual(UNKNOWN_CAPABILITY);
  });
});
```

#### 3.4.2 `reasoning_effort` 不注入测试

文件: `packages/kosong/test/openai-legacy.test.ts`

现有测试在第 871 行断言 `deepseek/deepseek-v4-flash` 的 `withThinking("xhigh")` 会得到 `reasoning_effort: xhigh`。**这个测试需要修改为不期望 `reasoning_effort` 被注入**。

需要新增的测试:

```typescript
describe('reasoning_effort with DeepSeek', () => {
  it('does NOT auto-inject reasoning_effort for deepseek-v4 when history has ThinkPart', async () => {
    const provider = createProvider({ model: 'deepseek-v4' });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'Thinking...' },
          { type: 'text', text: 'Hi!' },
        ],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'How are you?' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('does NOT inject reasoning_effort from withThinking() for deepseek-v4', async () => {
    const provider = createProvider({ model: 'deepseek-v4' }).withThinking('high');
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Think' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('still serializes reasoning_content for deepseek-v4 ThinkPart round-trip', async () => {
    const provider = createProvider({ model: 'deepseek-v4' });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'q' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: 'inner monologue' },
          { type: 'text', text: 'answer' },
        ],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'next' }], toolCalls: [] },
    ];
    const body = await captureRequestBody(provider, '', [], history);
    const messages = body['messages'] as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'inner monologue',
    });
  });
});
```

**需要修改的现有测试**:

1. `packages/kosong/test/openai-legacy.test.ts` line 871-883: `withThinking("xhigh") passes through reasoning_effort for model %s` → DeepSeek 行应改为断言 `undefined`
2. `packages/kosong/test/openai-legacy.test.ts` line 902-912: `withThinking("max") maps to xhigh` → `deepSeekModel` 断言改为 `undefined`

## 四、影响范围评估

| 改动项 | 影响文件 | 破坏性 | 风险 |
|--------|---------|--------|------|
| 能力表新增 DeepSeek 条目 | `capability-registry.ts` | 无 | 低 — 纯新增匹配 |
| 阻止 `reasoning_effort` 自动注入 | `openai-legacy.ts` | 无（仅影响 DeepSeek 模型） | 中 — 需确认无其他模型依赖此 auto-inject |
| 阻止 `reasoning_effort` 显式注入 | `openai-legacy.ts` | 有：现有测试断言 DeepSeek 接受 reasoning_effort | 中 — 需要同步修改测试 |
| 测试补充 | 2 个测试文件 | 无 | 低 |
| 修改现有测试 | `openai-legacy.test.ts` | 需要评审 | 低 — 只是预期值变化 |

## 五、验证清单

改完后逐项确认:

- [ ] `getModelCapability('openai', 'deepseek-v4').tool_use === true`
- [ ] `getModelCapability('openai', 'deepseek-v4').thinking === true`
- [ ] `getModelCapability('openai', 'deepseek-v4').image_in === true`
- [ ] `getModelCapability('openai', 'deepseek-v4-pro')` 同 V4
- [ ] `getModelCapability('openai', 'deepseek-reasoner').image_in === false`
- [ ] `deepseek-v4` 历史含 ThinkPart 时，请求体不含 `reasoning_effort`
- [ ] `deepseek-v4` 使用 `withThinking('high')` 时，请求体不含 `reasoning_effort`
- [ ] `deepseek-v4` 的 `reasoning_content` 多轮回传正常
- [ ] `deepseek-v4` 的工具调用正常
- [ ] `pnpm test --filter @wukong/kosong` 全绿

## 六、未来扩展

当前方案只处理 DeepSeek。如果后续要支持其他不支持 `reasoning_effort` 的 OpenAI 兼容模型（如 Qwen、Moonshot 等），可以将 `isModelWithoutReasoningEffort()` 扩展为一个更通用的能力检测，或者改为 `OpenAILegacyOptions` 中的可配置参数，由 `ProviderManager.toKosongProviderConfig()` 根据模型族自动设置。

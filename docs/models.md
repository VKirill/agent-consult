# Модели и варианты запуска агентов

**Единственный источник истины — `config.json`** (раздел `agents` + `synthesis`).
Чтобы сменить модель агента или глубину рассуждений — правишь **одну строку в `config.json`**;
код (CLI-аргументы и генерируемые `config.toml` песочниц) подхватывает значение автоматически.

## Где что лежит

| Что | Где задаётся |
|-----|--------------|
| Модель агента | `config.json → agents.<имя>.model` |
| Глубина рассуждений | `config.json → agents.<имя>.reasoning` (`enable`, `reasoning_effort`) |
| Персональный системный префикс | `config.json → agents.<имя>.system_prefix` |
| Модель синтезатора | `config.json → synthesis.model` |

> Раньше модели codex/grok/agy дублировались хардкодом в `src/agents/sandbox.ts`
> (генерация `config.toml`). Теперь они читаются из `config.json` через `modelForAgent()`
> — дубли убраны, дрейфа нет.

## Как агенты запускаются (карта вариантов)

Каждый агент — это локальный CLI. Модель передаётся в его «родном» формате, глубина
рассуждений — «родным» флагом. Эта механика per-CLI зашита в `src/agents/cli/invocation.ts`
(`buildCliArgs`) и `resolveAgentBinInfo` — менять её нужно только при **добавлении нового CLI-инструмента**,
а не при смене версии модели.

| Агент | CLI (bin) | Формат модели | Флаг глубины рассуждений | Промт |
|-------|-----------|---------------|---------------------------|-------|
| **codex** | `codex` | без префикса (`openai/gpt-5.5` → `gpt-5.5`) | `-c model_reasoning_effort=<effort>` | stdin |
| **claude** | `claude` | алиас (`sonnet`/`opus`/`haiku`) | `--effort <low\|medium\|high\|xhigh\|max>` | stdin |
| **agy** | `agy` (antigravity) | модель в `config.toml` (без `--model` в args) | — | stdin |
| **mimo** | `mimo` (mimocode) | полный provider/model (`xiaomi/mimo-v2.5-pro`) | `--variant <high\|max\|minimal>` | stdin |
| **grok** | `grok` | без префикса; `--model`, если не дефолт | — | prompt-file |

Текущие значения (`config.json`):

| Агент | Модель | reasoning |
|-------|--------|-----------|
| codex | `openai/gpt-5.5` | high |
| claude | `opus` | high (`--effort high`) |
| agy | `google/gemini-3.5-flash` | — |
| mimo | `xiaomi/mimo-v2.5-pro` | high (`--variant high`) |
| grok | `xai/grok-composer-2.5-fast` | — |
| *synthesis* | `minimax/minimax-m3` (OpenRouter) | — |

## Как сменить модель

1. Открой `config.json`.
2. В `agents.<имя>.model` поставь новую модель (в том же формате провайдера, например
   `openai/gpt-6` или `xiaomi/mimo-v3`).
3. При необходимости поправь `reasoning.reasoning_effort` (`low|medium|high|xhigh|max`).
4. `npm run build` (если сервер запускается из `dist/`) и переподключи MCP-сервер.

Никаких правок кода не требуется — `buildCliArgs` и генераторы `config.toml` берут модель
и reasoning из `config.json`.

## Как добавить НОВОГО агента (новый CLI-инструмент)

Это редкий случай и требует кода (новый CLI = новая механика запуска):
1. `config.json` — добавь блок `agents.<имя>` (model/reasoning/system_prefix).
2. `src/core/constants.ts` — добавь имя в `LOCAL_AGENTS`.
3. `src/agents/cli/invocation.ts` — `buildCliArgs`: ветка с аргументами CLI.
4. `src/agents/runner.ts` — `resolveAgentBinInfo`: путь к бинарю.
5. `src/agents/sandbox.ts` — авторизация/настройка home (если нужна).

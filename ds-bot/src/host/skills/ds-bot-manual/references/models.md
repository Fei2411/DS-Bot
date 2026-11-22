# Models, providers and thinking

A provider supplies model access. Each DS Bot-model Bot has its own model and optional thinking level. Switching a model is different from signing in to a provider or switching to a local agent CLI.

Each Bot's profile is its own saved configuration, not a separate DSH installation profile. Model Bots use DSH's model service and agent loop; local agents use the CLI's model access and tools. Memory review, handoffs, the context steward, image readings, side chats and browser_task call the model service outside the agent loop. Web search/fetch and DeepSeek OCR, TTS and ASR also make direct service requests: do not tell users every request goes through DSH model routing.

## Steps

1. The user opens **Settings → Models → Providers** to configure provider access.
2. Open **Settings → Bots**, select the Bot, then **Model** to choose its model and supported thinking level.
3. Use **Settings → Bot models** to review model choices across the team. **Settings → Usage** shows usage information.

Call `list_bot_models` for exact provider/model refs and supported thinking levels for models in use. Call `list_bots` to see the current assignment. Use `update_bot` with model or effort only for the user's requested choice. An empty effort returns to the model's default. Every Bot can change itself; a Main Bot can change another Bot.

For `create_bot`, if the user has not named a model, leave model out. The host chooses a usable team default or the creator's model. Do not silently select a more expensive model. Only the user moves a Bot between DS Bot models and a local CLI. Provider credentials, account sign-in and global provider setup are user-controlled UI work; there is no general Bot provider-settings tool described here.

## Problems

- A model ref must exist in the current catalog. Do not guess provider names.
- Missing credentials are not fixed by repeating the same request. Ask the user to configure the provider securely.
- Thinking levels differ by model. Do not send an unsupported effort value.
- Changing models does not give a text-only model image support. Explain when a screenshot or scanned document needs an image-capable model.
- Local agents use the CLI's own model access and tool behavior. Check **Local agents**, not just the shared model list.

Sources: README.md (Bot, Local agents); src/host/tools.js (list_bot_models, create_bot, update_bot); src/client/settings.js, bot-models-page.js, bot-settings.js; docs/plans/2026-11-13-bot-models.md.

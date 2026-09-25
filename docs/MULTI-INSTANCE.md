# Multi-instance research bots

Named instances let multiple Telegram bots use the same bridge code and project truth sources without sharing Telegram offsets, Codex threads, memories, account state, or logs.

The existing bot remains the `default` instance and keeps its original paths:

- LaunchAgent: `com.sharenla.telegram-codex-bridge`
- service root: `~/Library/Application Support/telegram-codex-bridge-service`

A named instance such as `strategy-observation` uses:

- LaunchAgent: `com.sharenla.telegram-codex-bridge.strategy-observation`
- service root: `~/Library/Application Support/telegram-codex-bridge-strategy-observation-service`
- store: `<service root>/data/store.json`
- Codex home: `<service root>/data/codex-home`
- logs: `<service root>/data/logs`

## Included research profiles

This repository includes two profiles:

- `strategy-observation`: observes live strategy behavior and produces optimization proposals.
- `rv-prediction`: researches and predicts realized volatility, with a provider-independent contract for a later Predictive AI handoff.

Both profiles:

- use `gpt-6-sol` with `high` reasoning;
- start in `read-only` sandbox mode;
- automatically accept routine Codex command, file, and permission requests so research turns do not pause on Telegram approval buttons; existing Deribit live hot-patch, deploy-gate, and restart guards still apply;
- point at `/Users/wukong/trading-deribit` and the shared source registry;
- retain broad access to live truth, APIs, market data, logs, and shared Codex capabilities;
- maintain independent threads, generated memories, and role instructions;
- do not silently edit their own role contract, but may propose concise amendments after repeated evidence.

## Prepare private instance configuration

The real `.env` files are ignored by Git. Create them from the committed templates:

```bash
cp config/instances/strategy-observation.env.example config/instances/strategy-observation.env
cp config/instances/rv-prediction.env.example config/instances/rv-prediction.env
```

Replace `TELEGRAM_BOT_TOKEN=replace_me` in each private file. The templates already carry the current Telegram allowlist and research defaults.

The installer rejects missing or placeholder bot tokens and allowlists. It never writes the bot token into the LaunchAgent plist.

## Install or update

```bash
npm run install:strategy-observation
npm run install:rv-prediction
```

Installation copies the selected private `.env` with mode `0600`, installs the role file as the instance's global `AGENTS.md`, generates an instance-specific LaunchAgent, and starts the supervisor.

The specialist profiles keep `CODEX_CONTEXT_SYNC=1` so shared `skills`, `plugins`, `rules`, and the safe parts of `config.toml` stay aligned with the desktop Codex profile. They set:

```dotenv
CODEX_CONTEXT_SYNC_AGENTS=0
CODEX_CONTEXT_SYNC_MEMORIES=0
CODEX_MEMORIES_ENABLED=1
```

This prevents desktop synchronization from replacing the specialist role or its independent generated memories, then explicitly enables memory generation and use inside that isolated Codex home without changing the desktop profile.

## Uninstall

```bash
npm run uninstall:strategy-observation
npm run uninstall:rv-prediction
```

Uninstalling removes only the matching LaunchAgent. It preserves the service data directory so threads and memories can be restored by reinstalling the instance.

## Generic named instances

The installer also accepts any lowercase, hyphenated instance id:

```bash
BRIDGE_ENV_FILE=/absolute/path/to/instance.env \
BRIDGE_ROLE_FILE=/absolute/path/to/AGENTS.md \
zsh scripts/install-launch-agent.sh my-instance
```

The id must match `^[a-z0-9][a-z0-9-]*$`. Re-running the command updates only that instance. If an already-installed named instance has a saved `.env` and role file, the installer can update its runtime copy without replacing those private files.

### Per-chat project bindings

Chat identifiers belong in private runtime configuration, not product source. The
installer preserves old hardcoded pins in each service's
`data/chat-project-bindings.json` before replacing its code. This file is excluded
from deployment sync and retains mode 0600 on creation. Existing files are preserved.
For new bindings, a private registry selected through `SOURCE_REGISTRY_PATH` may
supply a `chatProjectBindings` object mapping chat IDs to project profile IDs; it
overrides the local migration file. The bundled registry has no real chat IDs.
Malformed local bindings fail startup instead of silently dropping the pins.

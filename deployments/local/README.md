# OPAP local services / ローカルサービス

The Discord Gateway Bridge is experimental. Slash commands continue to work while it is stopped.

Discord Gateway Bridgeは実験機能です。停止中もSlash Commandは利用できます。

1. Copy `.env.example` to `.env` and enter the four Discord values.
2. Run `docker compose --profile discord-bridge up -d --build` in this directory.
3. Check `docker compose ps`; the service becomes healthy after connecting to Discord.

Windows and macOS use Docker Desktop. Linux uses Docker Engine. Images target `linux/amd64` and `linux/arm64`.
Ollama is intentionally external; `host.docker.internal` works on Docker Desktop and is mapped through `host-gateway` on Linux.

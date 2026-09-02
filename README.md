# m365-copilot-proxy (Dockerized)

This is a fork of the [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) project, tailored specifically for easy deployment via Docker and Dokploy.

This project wraps Microsoft 365 Copilot's WebSocket/SignalR API in an OpenAI-compatible interface with tool calling support, allowing you to use M365 Copilot as an LLM backend for OpenAI-compatible coding agents like pi and OpenClaw.

## Changes in this Fork
- **Containerized**: Added a multi-stage `Dockerfile` to create a minimal image.
- **Headless OAuth Support**: Added an `entrypoint.sh` script to seamlessly inject the Microsoft authentication cache (`msal-cache.json`) through environment variables. This avoids the need for direct file system access, making it perfect for PaaS platforms like Dokploy.
- **Docker Compose**: Includes a ready-to-use `docker-compose.yml`.

## Deployment (Dokploy & Docker)

### 1. Generate the Authentication Cache Locally
Because the server is headless and uses OAuth, you must first authenticate on your own local machine.

1. Clone the original repository on your computer or run the proxy locally.
2. Run it with the environment variable `M365_ENABLE_INTERACTIVE_APPROVAL=1` set.
3. Sign in via the browser window that appears.
4. After logging in, a file will be generated at `~/.config/opencode-m365/msal-cache.json`.
5. Open this file and copy all of its JSON contents.

### 2. Deploy to Dokploy (or Docker Compose)

1. Use the provided `docker-compose.yml` in your Dokploy service configuration.
2. Go to the **Environment Variables** section for your service in Dokploy.
3. Add a new environment variable named `M365_MSAL_CACHE_JSON`.
4. Paste the entire JSON string you copied from your local machine into the value of this variable.
5. Deploy the service.

The `entrypoint.sh` script will automatically read this variable and create the `msal-cache.json` file inside the container before the server boots up. The tokens will silently refresh in the background automatically.

## Usage

Once deployed, point your OpenAI-compatible client to your proxy URL (e.g., `http://your-domain.com/v1`).

Example models you can request:
- `gpt-5.5-think-deeper` (Recommended for agents/tool-calling)
- `m365-copilot` (Auto)

## License

MIT License. See [LICENSE](LICENSE). Please adhere to your Microsoft 365 tenant's acceptable-use policies.

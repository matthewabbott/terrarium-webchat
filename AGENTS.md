# Repository Guidelines

## Project Structure & Module Organization
Follow the monorepo layout promised in `_grok_design_discussion.md`. Runtime code belongs under `packages/`: `vps-server/` (Express + WebSocket relay), `web-frontend/` (Vite/React widget for mbabbott.com), and `terrarium-client/` (worker that talks to Terra, with adapters isolated in `src/tools`). Park shared DTOs, env templates, and reusable styles inside `/shared` so each workspace consumes identical contracts and examples.

## Build, Test, and Development Commands
Install dependencies once at the root with `npm install`; CI should use `npm ci`. Day-to-day loops: `npm run dev --workspace packages/vps-server`, `npm run dev --workspace packages/web-frontend` (proxies to `http://localhost:4000`), and `npm run start --workspace packages/terrarium-client` or `poetry run python main.py` if that package stays Python-first. Launch the full stack with `docker compose up dev` when you need the relay + worker together, and lint before commits via `npm run lint --workspaces`.

## Coding Style & Naming Conventions
Ship TypeScript in strict mode with 2-space indentation, camelCase identifiers, and PascalCase React components or GraphQL types. Python modules must follow PEP 8 (4-space indent, snake_case functions, SCREAMING_SNAKE env keys). Keep formatting automated with Prettier + ESLint for JS/TS and Ruff or Black for Python, triggered through pre-commit hooks so mixed-language diffs stay tidy.

## Testing Guidelines
Back-end routes rely on Vitest + supertest (or similar) with mocked in-memory stores; test auth, access-code gating, and external-provider code paths before merging. Web components use Vitest plus Playwright for chat flows against a local REST/WebSocket server. The terrarium client uses pytest (or Jest if we port pieces to TS) with Terra HTTP calls mocked, exercising prompt assembly, retry logic, and routing. Store reusable fixtures in `/shared/testing` so schemas and sample chats stay aligned.

## Commit & Pull Request Guidelines
History currently shows concise imperative subjects (“Initial commit”); continue that voice with optional scopes like `feat(vps): gate chats`. Squash noisy WIP commits locally, reference linked issues or mbabbott.com tasks, and attach reproduction steps or screenshots to every PR. When a change spans multiple packages, spell out the deploy plan (e.g., “restart pm2 on the VPS and redeploy the terrarium client”).

## Security & Configuration Tips
Never commit secrets: keep `.env.local` ignored and mirror required keys in `.env.example` (at minimum `CHAT_PASSWORD`, `SERVICE_TOKEN`, API bases, provider tokens, and the terrarium service credential). Validate visitor requests against the access code before forwarding to Terra, rate-limit REST writes, scrub logs prior to exporting, and rotate the terrarium client’s service token whenever relay credentials change.

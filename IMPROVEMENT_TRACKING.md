# Terrarium Webchat Stability & Performance Tracker

Context: maintain stability/responsiveness when up; maintenance downtime is acceptable. We intentionally skip chat/worker state persistence across deploys.

Roles
- **VPS-side coding agent**: relay (`packages/vps-server`), frontend (`packages/web-frontend`), deployment scripts/playbooks.
- **LLM-host-side coding agent**: worker/client (`packages/terrarium-client`), prompt/tools, Terra API integration.

Workstreams & Tasks

1) Guardrails & Config (VPS-side)
- Status: DONE | Task: Add startup env validation (zod/envalid) for relay; fail fast on missing/invalid values. DoD: CI fails on bad env; runtime logs a single fatal error and exits.
- Status: DONE | Task: Rate limiting and payload caps: per IP + per chatId, JSON body size limit, max message length. DoD: limits configurable via env; 429/413 responses covered by tests.
- Status: TODO | Task: Logging hygiene: strip tokens/access codes from logs; ensure `LOG_CHAT_EVENTS`/`LOG_ASSISTANT_CHUNKS` honored; rotate logs daily or by size. DoD: rotation tested locally; no secrets in logs.
- Status: DONE | Task: Deployment safety: script rsync scoped to `terra/` and `terrarium-server/` only, no `--delete` outside those. Add post-deploy smoke (curl health + WS ping). DoD: script checked in under `scripts/`, referenced in DEPLOYMENT.md.

2) Relay Resilience & Observability (VPS-side)
- Status: DONE | Task: Non-blocking log writes: queue + async fs writes to avoid event-loop blocking; bounded queue with drop/backpressure policy. DoD: load test shows stable latency; queue metrics exposed.
- Status: DONE | Task: WebSocket robustness: add heartbeat/ping-pong, stale-socket cleanup, and basic backpressure handling (close slow consumers). DoD: idle sockets are pruned; slow consumer test closes connection gracefully.
- Status: DONE | Task: Metrics: expose Prometheus-style endpoint (HTTP latencies, error counts, WS connections, worker latency, Terra latency when reported). DoD: metrics route behind service token; documented in README.

3) Frontend Responsiveness (VPS-side)
- Status: DONE | Task: New-message indicator when auto-scroll is paused; keep pause-on-scroll behavior. DoD: badge clears when scrolled to bottom.
- Status: DONE | Task: Stream rendering batching: batch streaming updates via requestAnimationFrame; trim stored history to cap size. DoD: large chat load benchmark stays smooth; localStorage cap enforced.
- Status: DONE | Task: Network resilience: add retry/backoff for REST, WS reconnect with jitter, clearer connection status. DoD: configurable retry policy; visual feedback in UI; manual test plan in repo.

4) Worker Robustness (LLM-host-side)
- Status: TODO | Task: Terra API resilience: timeouts, retry with jitter, simple circuit breaker, and error categorization (timeout/4xx/5xx) feeding worker-state detail. DoD: unit tests + integration stub; UI shows clearer errors.
- Status: TODO | Task: Tool schema single source of truth: generate prompt/tool lists from one schema to prevent drift. DoD: one definition drives both `prompt.py` and `ToolExecutor`; tests guard drift.
- Status: TODO | Task: Concurrency controls: configurable max in-flight Terra calls; queue/backpressure for busy chats. DoD: load test with multiple chats shows bounded concurrency and no duplicate handling.
- Status: TODO | Task: Agent API robustness (LLM-host): add concurrency limits on streaming and non-streaming calls, per-request timeouts/retries with jitter, and a simple circuit breaker; surface metrics (latency/error counts, open streams). DoD: capped concurrent streams, metrics endpoint/doc, structured errors.
- Status: TODO | Task: Worker logging efficiency: replace per-call file writes with a small bounded async log queue + drop counter to avoid event-loop stalls under load. DoD: load test shows stable latency; drops counted.

5) Security Hardening (Joint, with ownership marked)
- Status: TODO | Task: Worker↔relay auth upgrade (HMAC signing or mTLS). Owner: LLM-host to implement signing; VPS-side to verify. DoD: toggle-able via env; compatibility path maintained.
- Status: TODO | Task: Abuse protection on public POST: optional CAPTCHA or lightweight challenge. Owner: VPS-side. DoD: feature flag; documented impact.

Assumptions & Notes
- Chat/worker state persistence across deploys is out of scope for now.
- Maintenance windows are acceptable; schedule disruptive changes (auth/mTLS) with coordination between agents.
- Add tests where specified; prefer Vitest for relay/frontend and pytest for worker.***

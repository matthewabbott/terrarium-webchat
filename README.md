# terrarium-webchat

Web chat harness for Terra (GLM-4.5 running in `terrarium-agent`). The goal is to serve a gated chat widget on **mbabbott.com** by relaying visitor messages through a lightweight Express + WebSocket relay on the VPS and back to Terra via an outbound-only worker.

## Repo Layout

```
.
├── AGENTS.md              # Contributor quick-reference
├── DESIGN.md              # Architecture + TODO backlog
├── docker-compose.yml     # Dev stack (REST relay + worker)
├── package.json           # npm workspaces definition
├── packages/
│   ├── vps-server/        # REST + WebSocket relay (Node/TypeScript)
│   ├── web-frontend/      # Chat widget (Vite/React)
│   ├── terrarium-client/  # Outbound worker (Python entrypoint + npm wrapper)
│   └── shared/            # Shared schema/types/configs
└── tsconfig.base.json
```

See `DESIGN.md` for the detailed architecture plan and prioritized backlog, and `DEPLOYMENT.md` for VPS + worker setup steps. The relay exposes its REST + WebSocket API under `/api/*` by default; set `BASE_PATH=/terrarium` (or similar) if you need the routes namespaced behind your main site. When building the frontend for production, set `VITE_BASE_PATH` (e.g. `/terra/`) and keep `VITE_API_BASE`/`VITE_WS_BASE` trailing with `/` so relative URLs stay under that prefix.

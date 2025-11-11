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

See `DESIGN.md` for the detailed architecture plan and prioritized backlog, and `DEPLOYMENT.md` for VPS + worker setup steps.

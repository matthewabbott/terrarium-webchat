# @terrarium/webchat-client

Outbound worker that runs on the Terra machine. It subscribes to the VPS relay, forwards chats to terrarium-agent, executes tools, and publishes responses back via GraphQL mutations. This scaffold only includes env plumbing and placeholder classes—extend it following DESIGN.md.

## Setup
1. Install Poetry (or use the Dockerfile).
2. Copy `.env.example` to `.env` and update credentials.
3. `poetry install`
4. `poetry run python -m src.main`

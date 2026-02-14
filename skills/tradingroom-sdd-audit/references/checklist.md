# TradingRoom SDD Audit Checklist

## 1. Spec-vs-Code Parity

- [ ] TradingRoom concepts in spec map to concrete runtime files and endpoints.
- [ ] Acceptance criteria in spec are either implemented or explicitly documented as pending.
- [ ] Architecture naming is current (`TradingRoom`, `agent-dashboard`) with no stale primary references.

## 2. WS Contract Parity

- [ ] `packages/types/src/realtime.ts` includes all message types consumed by UI.
- [ ] Backend emits `FULL_STATE`, `STATE_DELTA`, `ROOM_STATE`, `PONG` and optional `TRADE_EVENT` with expected shapes.
- [ ] Dashboard message handler branches match backend message contracts.

## 3. Bot Identity Mapping

- [ ] Canonical `agentId` is stable and user-facing (slug) across API, DO, and UI.
- [ ] DO identifier (if present) is isolated as diagnostics (`doId`) and not used as UI primary key.
- [ ] Bot registration, room state cache, and dashboard cards map the same key.

## 4. Auth Coverage

- [ ] API routes enforce shared-secret auth.
- [ ] WS upgrade path enforces auth.
- [ ] Frontend REST and WS clients include auth credentials.
- [ ] Env typing includes required auth variable(s).

## 5. Build/Test Script Health

- [ ] Root scripts (`test`, `lint`, `start`) run without broken placeholder flags.
- [ ] Engine package includes runnable tests for risk/strategy/indicators.
- [ ] Integration path exists for TradingRoom WS + emergency-stop behavior.

## 6. Docs Drift

- [ ] `README.md` and specs reflect current package/app names.
- [ ] QA report statements match actual command outcomes.
- [ ] Security docs reflect current auth requirement.

# Errors

> Prev: [messages.md](./messages.md) · Index: [index.md](./index.md)

| Code | When | Action |
|------|------|--------|
| `NOT_FOUND` | unknown `bot_id`; `GetWorld` with no world; `GetTile` OOB; `GetObject`/`GetPlayer`/`GetItemInfo` miss | list via `ListBots`, re-check world/ids (see [queries.md](./queries.md)) |
| `INVALID_ARGUMENT` | missing `BotRef`; empty `username/password`/`ltoken`; bad proxy host; `packet_type>255`; negative `WalkTo`/`FindPath`; `SetCollectRange`/`radius_tiles>255`; `GetItemInfo` with no key | fix request shape (see per-group file) |
| `UNAUTHENTICATED` | `MORI_GRPC_TOKEN` set but `authorization: Bearer <token>` missing/wrong | export `MORI_GRPC_TOKEN`, pass `metadata` on every call (see [quickstart.md](./quickstart.md)) |
| `INTERNAL` | manager lock poisoned | restart server, report |

## Status values (`bot_status`, `GetBotState.status`)

`connecting` (initial) · `connected` · `in_game` (select or world) · `disconnected` (manual, needs `Reconnect`) · `two_factor_auth` (retry after `twofa_secs`) · `server_overloaded` (`server_overload_secs`) · `too_many_logins` (`too_many_logins_secs`) · `update_required` (permanent) · `maintenance` (`maintenance_secs`)

Delays tunable via [settings.md](./settings.md).

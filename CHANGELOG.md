# Changelog

## 0.1.0-rc1 (2026-10-22)

First release of the SDK and the on-chain core, implementing the MOI
Authority Layer specification (mal.md, version 1).

### Contracts

- **AuthorityRegistry** is the store of record. It keeps grants and
  delegations under §2.2 ids (`grt_<owner>_<seq>`, `del_<owner>_<seq>`),
  checks who writes (the DID's controller) and who revokes, and enforces
  the §2.8 counts. Shape, structure and attenuation are checked by the SDK
  before writing and re-proven by the resolver on every read (§3.1, §3.7).
- Revocations by anyone but a record's owner are kept in the registry's own
  state, so nothing is written into an account by anyone else (§3.6).
- **MoiIdentity**, the identity layer: every account owns
  `did:moi:<address>` with no registration, controls it forever, and can
  turn it off and on. There is no key or controller rotation (§1.6).
- Deployed on the devnet; those are the SDK's default logic ids.

### SDK

- `AuthorityRegistry`: deploy, connect, `enlist`, every §3 write with the
  §3.3 checks run client-side (no fuel spent on a refusal), reads, paging,
  local §3.7 resolution with `requireActive`, `verifyRecord`, and §3.8
  events with `events`, `watch` and `getEvents`.
- `MoiIdentity` and the `did:moi` helpers `didOf`, `homeOf`, `isMoiDid`.
- Default logic ids for the devnet deployment, overridable with
  `MOI_AUTHORITY_REGISTRY_LOGIC_ID` and `MOI_IDENTITY_LOGIC_ID` or a
  `logicId` option.
- The §3.7 resolver over any record source, the §3.4 attenuation checker,
  the §3.3 shape checks and the §2.2 id utilities, all exported.
- Transport: participant declaration, simulation-sized fuel, detection of
  discarded state changes, retries on participant lock conflicts, one
  submission at a time per account, and receipt timeouts reported with the
  interaction hash.
- Events: each event in a range delivered exactly once; network failures
  thrown rather than read as empty ranges; `watch` retries from a failure,
  reports it to `onError` and never rejects unhandled.
- Runs in Node 20+ and any runtime js-moi-sdk supports (no Node built-ins).

![MOI](https://moi-js.s3.amazonaws.com/moi-banner.png)

[![npm](https://img.shields.io/npm/v/js-mal-sdk?style=for-the-badge&color=red)](https://www.npmjs.com/package/js-mal-sdk)
[![ci](https://img.shields.io/github/actions/workflow/status/sarvalabs/js-mal-sdk/ci.yml?branch=main&style=for-the-badge&label=ci)](https://github.com/sarvalabs/js-mal-sdk/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT%2FApache--2.0-informational?style=for-the-badge)

# js-mal-sdk

**Scoped, revocable authority for AI agents, recorded on MOI.**

Agents now buy, pay and act for people. `js-mal-sdk` is the JavaScript/TypeScript SDK for the **MOI Authority Layer (MAL)**. A person grants an agent exactly what it may do, the agent can pass a narrower slice on to other agents, and the person can revoke any of it at any moment. Any service can check, in one call, that an action is backed by a live, unbroken chain of consent.

```ts
const authority = await registry.resolveAuthority(order.ref);
// → who granted it, which agent holds it, what it may do, until when. Or a reason it can't.
```

## Contents

- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Verifying an action](#verifying-an-action)
- [Identity: `did:moi`](#identity-didmoi)
- [Following the registry](#following-the-registry)
- [Deployments](#deployments)
- [The MOI ecosystem](#the-moi-ecosystem)
- [API reference](#api-reference)
- [Errors](#errors)
- [Limits](#limits)
- [Contracts](#contracts)
- [Development](#development)

## Features

- **Grant, delegate, revoke.** Every operation of the MOI Authority Layer, typed end to end.
- **Delegation can only narrow.** Fewer actions, lower limits and earlier expiries only. A wider request fails with `SCOPE_ESCALATION` before anything is sent.
- **One-call verification.** `resolveAuthority` re-proves every link of a chain from the records on MOI, at any depth. Reads are free.
- **Instant revocation.** Revoke a grant, and every delegation under it stops resolving at once, for every verifier.
- **Self-certifying identities.** Every MOI account owns the DID `did:moi:<accountId>` with no registration, and can switch it off and on.
- **Reliable writes.** Fuel is sized by simulation, discarded state is detected, conflicting writes are retried, and concurrent writes from one account are serialized.
- **Live events.** Replay or watch grants, delegations and revocations, with records written around the SDK filtered out.
- **Ready to use.** Deployed on MOI's public devnet. ESM, TypeScript types included, no Node built-ins.

## Installation

```sh
npm install js-mal-sdk js-moi-sdk
```

`js-moi-sdk` (0.9.x) is a peer dependency. You use it directly for wallets and providers, and the SDK shares your copy. npm 7+ and pnpm install it automatically; with Yarn, add it yourself. Requires Node 20+.

## Quick start

Connect to the registry on the public devnet with a funded MOI account. The account needs KMOI to pay fuel; [MOI Wallet](https://wallet.moi.technology) is the easiest way to create one.

```ts
import { VoyageProvider, Wallet } from "js-moi-sdk";
import { AuthorityRegistry, didOf } from "js-mal-sdk";

const wallet = await Wallet.fromMnemonic(process.env.MNEMONIC!, "m/44'/6174'/0'/0/1");
wallet.connect(new VoyageProvider("devnet"));

const registry = await AuthorityRegistry.connect(wallet); // the devnet registry by default
await registry.enlist(); // once per account that issues grants or delegations
```

**1. Grant.** Priya lets her shopping agent buy a phone and a case, up to 50,000, for a week.

```ts
const priya = didOf(await registry.signerId());
const shopper = didOf(SHOPPER_ACCOUNT_ID);

const { grantId } = await registry.createGrant({
    context: "Pixel 10 and a case, this week",
    grantorDid: priya,
    grantees: [shopper],
    scope: [{
        resource: "shop:order",
        actions: ["buy"],
        constraints: {
            products: { kind: "strings", value: ["pixel-10", "pixel-10-case"] },
            max_amount: { kind: "number", value: 50_000 },
        },
    }],
    maxDelegationDepth: 1,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400,
});
```

**2. Delegate.** The shopper, signing with its own wallet, passes on just the case.

```ts
const asShopper = await AuthorityRegistry.connect(shopperWallet);
await asShopper.enlist();

const { delegationId } = await asShopper.createDelegation({
    grantId,
    parentId: grantId,
    delegatorDid: shopper,
    delegateeDid: didOf(HELPER_ACCOUNT_ID),
    scope: [{
        resource: "shop:order",
        actions: ["buy"],
        constraints: {
            products: { kind: "strings", value: ["pixel-10-case"] },
            max_amount: { kind: "number", value: 2_000 },
        },
    }],
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
});
```

**3. Verify.** A store checks the helper's order before shipping.

```ts
const authority = await registry.resolveAuthority(delegationId);
authority.grantorDid;   // Priya: who the action is accountable to
authority.actorBinding; // [helper]: who may act
authority.scope;        // the case, at most 2,000
authority.chain;        // [delegationId, grantId]
```

**4. Revoke.** Priya changes her mind; the grant and everything under it stop resolving.

```ts
await registry.revokeGrant(grantId);
await registry.resolveAuthority(delegationId); // throws AuthorityError: GRANT_REVOKED
```

## Concepts

| | |
|---|---|
| **Grant** | A person (the grantor) gives one or more agents (grantees) a scope for a context, with an expiry and a maximum delegation depth. |
| **Delegation** | An agent passes part of its authority to one other agent. It can only narrow its parent. |
| **Scope** | A list of entries, each a `resource`, its `actions`, and `constraints`. A constraint is a `string`, `number`, `boolean`, `strings`, `numbers` or `ref`. A number is a ceiling, a list is an allow-list, and the others must match exactly. |
| **Revocation** | The grantor revokes a grant; the delegator or the root grantor revokes a delegation. Everything below a revoked record dies with it. Revocation is final. |
| **Resolution** | Walks a grant or delegation id back to its grant, re-proving every link, and returns the effective authority or the reason it isn't live. |
| **Ids** | `grt_<account>_<n>` and `del_<account>_<n>`. They tell the SDK where a record is stored, and nothing more. |

Timestamps are Unix seconds. Expiry is exclusive: a record is dead at `expiresAt`.

## Verifying an action

Resolution tells you whether the authority is live and what it allows. Your service then checks that the action fits it:

```ts
import { AuthorityError } from "js-mal-sdk";

async function authorize(ref: string, agentDid: string, product: string, amount: number) {
    try {
        const authority = await registry.resolveAuthority(ref, { requireActive: true });
        if (!authority.actorBinding.includes(agentDid)) return deny("not the holder");

        const entry = authority.scope.find((e) => e.resource === "shop:order" && e.actions.includes("buy"));
        const products = entry?.constraints.products;
        const max = entry?.constraints.max_amount;
        if (products?.kind !== "strings" || !products.value.includes(product)) return deny("product not allowed");
        if (max?.kind !== "number" || amount > max.value) return deny("over the limit");

        return allow(authority.grantorDid);
    } catch (error) {
        if (error instanceof AuthorityError) return deny(error.code); // GRANT_REVOKED, DELEGATION_EXPIRED, BROKEN_CHAIN, ...
        throw error; // network trouble: retry, don't allow
    }
}
```

- **Prove the caller is the agent.** Resolution says who may act; it can't tell who is calling. Have the agent sign the request with its account key and check the signature against the account's keys on MOI.
- **`requireActive: true`** also refuses when the grantor's or the agent's DID is switched off. Use it for anything that moves money.
- **Fail closed.** Deny on any `AuthorityError`, and on a constraint key or kind your service doesn't understand.

## Identity: `did:moi`

`MoiIdentity` is the identity layer the registry is bound to. Every MOI account owns `did:moi:<its accountId>` from the start. Nobody else can claim it, and control never moves.

```ts
import { MoiIdentity, didOf, homeOf, isMoiDid } from "js-mal-sdk";

didOf(accountId);              // "did:moi:<accountId without 0x>"
homeOf(did);                   // the accountId that controls a did:moi DID
isMoiDid("did:example:123");   // false

const identity = await MoiIdentity.connect(wallet);
await identity.setActive(await identity.did(), false); // freeze: every requireActive check now refuses
await identity.setActive(await identity.did(), true);  // and back
```

While a DID is switched off it can't issue or receive new grants or delegations, and its owner can still revoke what it issued.

## Following the registry

Replay history, or stream new events as they land. With `verified: true`, events about records written around the SDK are dropped.

```ts
// Replay
for await (const event of registry.events({ fromHeight: 0, verified: true })) {
    console.log(event.name, event.height); // GrantCreated, DelegationCreated, GrantRevoked, ...
}

// Stream: at least once, in order. Make the handler idempotent.
const stop = registry.watch((event) => cache.apply(event), {
    fromHeight: lastSeenHeight,
    verified: true,
    onError: (error) => logger.warn(error), // the watch retries from the failure; it never stops on its own
});
```

`getEvents(receipt)` returns the events of one interaction you sent.

## Deployments

The SDK connects to the contracts deployed on MOI's devnet unless you point it elsewhere. The network itself is whatever provider your wallet uses, such as `new VoyageProvider("devnet")` from `js-moi-sdk`.

| Contract | Environment variable | Default (devnet) |
|---|---|---|
| AuthorityRegistry | `MOI_AUTHORITY_REGISTRY_LOGIC_ID` | `0x20000000da714779e4a5a3e9aad5e280ce90a026757ef8ca0c2a8d2400000000` |
| MoiIdentity | `MOI_IDENTITY_LOGIC_ID` | `0x20000000928c74bb345d4bdc726dfe22ed485742c6640a9df86d71b300000000` |

The values in effect are exported as `REGISTRY_LOGIC_ID` and `IDENTITY_LOGIC_ID`. To pick a deployment in code instead, pass `logicId`:

```ts
const registry = await AuthorityRegistry.connect(wallet, { logicId: MY_REGISTRY_LOGIC_ID });
```

`connect` reads the registry's bound identity layer from MOI, so `registry.identityLogicId` always matches it. To deploy your own pair, use `MoiIdentity.deploy(signer)` and `AuthorityRegistry.deploy(signer, { identityLogicId })`.

## The MOI ecosystem

| | |
|---|---|
| [**MOI Wallet**](https://wallet.moi.technology) | Self-custodial wallet for iOS, Android and Chrome. Create accounts, hold KMOI, and approve dApp requests over WalletConnect v2 or the extension's `window.moi` provider ([developer docs](https://docs.wallet.moi.technology/developer/overview)). |
| [**js-moi-sdk**](https://github.com/sarvalabs/js-moi-sdk) | Wallets, providers and interactions for MOI. `js-mal-sdk` builds on it. |
| [**Coco**](https://cocolang.dev) | The language MOI logics are written in, including this SDK's contracts. |
| [**Discord**](https://discord.moi.technology/) | Questions, help and announcements. |

**Signing.** Every write is signed by the `js-moi-sdk` `Signer` you connect with. Agents and servers typically use a `Wallet` with a key in a KMS or vault. To have people approve their own grants and revocations in MOI Wallet, connect with a `Signer` that forwards `signInteraction` to the wallet. This package doesn't include such an adapter yet.

## API reference

### `AuthorityRegistry`

| Method | Returns |
|---|---|
| `AuthorityRegistry.connect(signer, { logicId }?)` | a connection signing as `signer`; `REGISTRY_LOGIC_ID` by default |
| `AuthorityRegistry.deploy(signer, { identityLogicId }?)` | a new registry bound to that identity layer; `IDENTITY_LOGIC_ID` by default |
| `enlist()` | `WriteResult`, or `null` if already enlisted |
| `isEnlisted(accountId?)` | `boolean` |
| `createGrant(input)` | `WriteResult & { grantId }` |
| `createDelegation(input)` | `WriteResult & { delegationId }` |
| `revokeGrant(grantId)` / `revokeDelegation(delegationId)` | `WriteResult` |
| `getGrant(id)` / `getDelegation(id)` | the record, or `null` |
| `listGrants(accountId, { offset, limit }?)` / `listDelegations(...)` | `{ ids, total }`, oldest first |
| `resolveAuthority(ref, { requireActive }?)` | `ResolvedAuthority`, or throws the reason |
| `verifyRecord(id)` | whether the record was valid when written |
| `isActive(did)` / `controllerOf(did)` | the identity layer's answer |
| `events(options?)` / `watch(handler, options?)` / `getEvents(receipt)` | registry events |
| `signerId()` | the signing account's accountId |

`WriteResult` is `{ hash, fuelUsed, receipt }`. `ResolvedAuthority` is `{ grantId, context, grantorDid, actorBinding, scope, maxDelegationDepth, expiresAt, chain }`.

Connection options: `logicId` (see [Deployments](#deployments)), `fuelPrice` (default 50), `maxFuel` (5,000,000), `fuelMultiplier` (1.5), `retries` (3), `receiptTimeout` in seconds (120), and `clock` for client-side time checks.

### `MoiIdentity`

| Method | Returns |
|---|---|
| `MoiIdentity.connect(signer, { logicId }?)` / `MoiIdentity.deploy(signer)` | a connection; `IDENTITY_LOGIC_ID` by default |
| `did()` | the signing account's DID |
| `isActive(did)` / `controllerOf(did)` | `boolean` / the controlling accountId |
| `setActive(did, active)` | `WriteResult`; only the DID's own account may |

### Utilities

| Export | |
|---|---|
| `didOf`, `homeOf`, `isMoiDid` | `did:moi` helpers |
| `resolveAuthority(ref, now, source)` | the resolver over any record source, such as your own cache |
| `attenuationEscalation`, `isNarrower`, `entryEscalation`, `constraintWithin` | whether one scope narrows another |
| `validateGrantInput`, `validateDelegationInput`, `validateScope` | the shape checks every write runs |
| `buildId`, `parseId`, `routeOf`, `isGrantId`, `isDelegationId` | ids |
| `decodeLog` | decode a raw registry log |
| `REGISTRY_LOGIC_ID`, `IDENTITY_LOGIC_ID` | the default deployments |
| `LIMITS`, `ErrorCode`, `VERSION` | constants |

## Errors

Every failure is an `AuthorityError` with a `code`, a `message` and `details`.

| Code | When |
|---|---|
| `GRANT_REVOKED`, `DELEGATION_REVOKED` | a record in the chain was revoked |
| `GRANT_EXPIRED`, `DELEGATION_EXPIRED` | a record in the chain expired |
| `UNKNOWN_GRANT`, `UNKNOWN_DELEGATION` | no such record |
| `BROKEN_CHAIN` | a record is malformed, mislinked or wider than its parent; it was written around the SDK |
| `UNSUPPORTED_VERSION` | a record of a schema version this SDK doesn't read |
| `UNKNOWN_PARTY` | a DID isn't active in the identity layer |
| `SCOPE_ESCALATION` | a delegation asks for more than its parent holds; the message names the entry and dimension |
| `DEPTH_VIOLATION` | a delegation is deeper than the grant allows |
| `DELEGATION_NOT_PERMITTED` | the parent delegation may not delegate |
| `NOT_HOLDER` | the delegator doesn't hold the parent |
| `UNKNOWN_PARENT`, `PARENT_REVOKED`, `PARENT_EXPIRED` | the parent of a new delegation can't be used |
| `NOT_CONTROLLER` | the signer doesn't control the grantor or delegator DID |
| `NOT_AUTHORIZED_TO_REVOKE`, `ALREADY_REVOKED` | a revocation the registry refuses |
| `NOT_ENLISTED` | the signing account hasn't called `enlist()` |
| `NOT_DID_CONTROLLER`, `UNKNOWN_DID` | a `MoiIdentity` change the identity layer refuses |
| `INVALID_SHAPE` | the input breaks a shape rule or a limit; the message names the field |
| `INVALID_ARGUMENT` | a malformed id, accountId or DID |
| `STATE_REVERTED` | the network discarded a write, usually because the sender can't pay for the storage it adds |
| `NETWORK_ERROR` | anything else from the network; on a receipt timeout, `details.hash` names the interaction, which may still land |

Validation runs before anything is sent, so most refusals cost no fuel.

## Limits

| | |
|---|---|
| Scope entries | 64 |
| Actions per entry | 64 |
| Constraints per entry | 32 |
| Values per list constraint | 64 |
| Grantees per grant | 32 |
| Delegation depth | 16 |
| Any string (context, DIDs, keys, values) | 256 bytes |
| A whole scope | 16 KB |

Also exported as `LIMITS`.

## Contracts

The [repository](https://github.com/sarvalabs/js-mal-sdk) contains the on-chain core, written in Coco.

- **AuthorityRegistry** (`contracts/authority/authority_registry.coco`) is the store of record. It authorizes every write against the identity layer, decides who may revoke, and enforces the limits. Shape, structure and attenuation are checked by the SDK before each write and re-proven on every read. Revocations by anyone but a record's owner (a root grantor pruning a delegation) are kept in the registry's own state and paid for from its KMOI balance, about 0.04 KMOI each, so keep a deployed registry funded.
- **MoiIdentity** (`contracts/identity/moi_identity.coco`) gives every account its `did:moi` DID. It stores nothing of its own, so the 10 KMOI deploy fund is enough for good.

## Development

```sh
git clone https://github.com/sarvalabs/js-mal-sdk.git
cd js-mal-sdk
npm install
npm test            # build, then unit tests
npm run typecheck
```

After changing a contract, recompile it with `coco compile` in its folder (`contracts/authority/` or `contracts/identity/`) and regenerate its embedded manifest (`src/manifest.ts` or `src/identity-manifest.ts`) from the YAML with `coco manifest convert -f json`. The contracts are tested in Cocolab, and the SDK end to end on a devnet.

```
src/          the SDK
contracts/    authority/ (AuthorityRegistry) and identity/ (MoiIdentity), in Coco
test/         unit tests; fixtures/ holds logs recorded on a devnet
```

**Status:** pre-1.0; APIs may change before `1.0.0`. See the [changelog](https://github.com/sarvalabs/js-mal-sdk/blob/main/CHANGELOG.md).

## Security

Please don't open public issues for vulnerabilities. See [`SECURITY.md`](https://github.com/sarvalabs/js-mal-sdk/blob/main/SECURITY.md).

## License

© 2026 Sarva Labs Inc. & MOI Protocol Developers. Licensed under either of [Apache License 2.0](https://github.com/sarvalabs/js-mal-sdk/blob/main/LICENSE-APACHE) or [MIT](https://github.com/sarvalabs/js-mal-sdk/blob/main/LICENSE-MIT), at your option (`MIT OR Apache-2.0`).

Unless you state otherwise, any contribution you intentionally submit for inclusion in this work, as defined in the Apache-2.0 license, is dual licensed as above, without any additional terms or conditions.

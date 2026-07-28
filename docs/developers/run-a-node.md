# Run a tiny node

The tiny chain is an EVM network that runs on machines we don't own. You can be
one of those machines. Nobody has to approve it, and you don't need a key from
us.

There are two different things people mean by "participate", and it's worth
keeping them apart:

| | What it takes | What you get |
|---|---|---|
| **Full node** | Besu, and one command | Every block, re-executed by you. Your own RPC. The standing to contradict us. |
| **Validator** | The above, plus stake | A seat in consensus — you propose blocks and earn issuance. |

The first needs nothing from anyone. The second needs the stake asset, which is
the honest bottleneck: no endpoint can hand it to you.

## The chain publishes itself

Everything you need is one HTTP call. No clone, no signup, no support ticket:

```bash
curl -fsSL https://tiny.technology/api/chain/join
```

That returns the chain id, the validator registry address, the requirements, the
bootnodes we can offer, and the genesis inlined. To get just the genesis — the
one file the peer handshake insists on:

```bash
curl -fsSL 'https://tiny.technology/api/chain/join?format=genesis' -o tiny-genesis.json
```

Those are the same bytes the founding nodes boot from, served straight from the
file they read. Not a copy kept in sync by hand — a copy would eventually drift,
and the only symptom would be *you* unable to peer, for reasons that look like
your network.

## Start it

```bash
besu \
  --genesis-file=tiny-genesis.json \
  --data-path=./tiny-node \
  --bootnodes=<enode of any peer> \
  --sync-mode=FULL \
  --data-storage-format=BONSAI \
  --min-gas-price=0 \
  --rpc-http-enabled --rpc-http-port=8545 \
  --rpc-http-api=ETH,NET,WEB3,QBFT,TXPOOL
```

!!! warning "It has to be Besu, and it has to be Java 25+"

    The chain runs QBFT. geth and anvil cannot follow it — this isn't a
    preference, they have no code path for these headers. And Besu 26.7.0 is
    compiled for Java 25+; on Java 21 it dies with an
    `UnsupportedClassVersionError` whose first line mentions neither Java nor a
    version number, which is a bad half-hour if nobody warned you.

`--sync-mode=FULL` is the point, not a tuning choice. A snap-synced node trusts
somebody else's state root. A full node re-executes every transaction from
genesis and computes state itself — which means it can disagree with us, and be
right. That capability is the entire reason to let strangers run nodes.

## Check that you hold *our* chain

A rising block number proves nothing: a node alone on its own fork looks
flawless by that measure. Compare hashes instead.

```bash
# your node and any other node must return the same genesis hash
curl -s -X POST http://127.0.0.1:8545 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x0",false]}'
```

The handshake enforces this, so a genesis mismatch shows up as "cannot peer" —
never as a quiet fork.

!!! tip "Peered, but stuck at block 0?"

    You are being **refused** the chain, not syncing slowly. Your own log names
    the rule that rejected the block:

    ```bash
    grep -E 'Invalid block|ValidationRule' tiny-node/besu.log | head
    ```

    A validator-set rule means the genesis mode transition is being misread —
    tell us, because that class of bug is invisible to every node that already
    holds the blocks. The first person it can possibly hurt is a newcomer.

## Becoming a validator

Also permissionless, and also not automatic:

1. Hold at least `MIN_STAKE` of the chain's TinyUSDC.
2. `approve(TinyValidators, amount)`, then `stake(amount)`.
3. Call `rotate()` yourself at an epoch boundary. Not us — you. If it needed our
   key, the chain wouldn't be open.
4. You're seated if you rank in the top `MAX_VALIDATORS` by stake. Entry is
   uncapped; **seats** are capped, because QBFT costs O(n²) messages.

Two things stated plainly, because the flattering version would be a lie:

- **Your stake is a deposit, not a bond.** Equivocation is adjudicated on-chain
  and the conviction is permanent and public — but nothing burns stake yet.
  Until a registry change ships, nobody should describe this stake as slashable,
  including us.
- **`unstake()` returns it in full** after the unbonding period. Leaving works,
  and that's tested rather than assumed.

## Gas is free, not unmetered

Base fee is zero, so a transaction costs nothing to send. But a sender that
doesn't **exist in state** cannot be included: the pool accepts your transaction,
gossips it, and then no proposer ever selects it — silently, with no error
anywhere. One wei is enough to fix it. If your first transaction never mines,
this is almost always why.

## What running a node does *not* do

It doesn't put you on the payment path. The join document tells you which chain
this deployment settles x402 payments on, and it is not necessarily the one you
just synced. Verifying a chain and being paid on it are separate things, and the
endpoint says which is which rather than letting you assume.

# gbrain's QM memory provider contract

`qm-memory-provider-v3.json` is gbrain's machine-readable contract for the tools QM calls on a gbrain: `memory_recall` and `memory_write`, which the [gbrain recipe](../../../docs/memory-providers.md#gbrain) and registry brains call, and the personal tools QM may call in a person's own DM, such as `forget_fact`. It holds their input schemas, the `x-qm-actor` rules, the answer shapes and every refusal code with its class. [`test/gbrain-memory-provider.test.ts`](../../gbrain-memory-provider.test.ts) serves these tools from a fake gbrain and checks that QM sends requests the schemas accept and records each answer and refusal as the contract classes it.

| Field   | Value                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Source  | `docs/contracts/qm-memory-provider/v3.json` in [garrytan/gbrain](https://github.com/garrytan/gbrain) |
| Status  | Tagged release `v0.60.655.0` at `79781ec0`                                                           |
| SHA-256 | `2a72688987f0b6d5179b2ebdd6de7fcbb8e5ae13ba09c5b4b8e6a0f7aa48f5ad`                                   |

The file is gbrain's bytes, unchanged, so `sha256sum qm-memory-provider-v3.json` proves which release it came from. Prettier skips it for that reason.

## Updating to a new gbrain release

1. Copy the release's `docs/contracts/qm-memory-provider/v<N>.json` over this fixture without reformatting it, naming it `qm-memory-provider-v<N>.json`, and point `.prettierignore` and the test at the new name.
2. Update the table above with the tag, its commit and the new `sha256sum`, and the gbrain line under "Pinned versions" in [docs/memory-providers.md](../../../docs/memory-providers.md#gbrain).
3. Run `node --test test/gbrain-memory-provider.test.ts`. A failure names the request field or outcome that no longer matches; fix QM or the recipe, never the fixture.
4. Repeat the recipe's [Verify](../../../docs/memory-providers.md#verify) steps against a brain running that release.

QM targets one gbrain contract at a time, so a new contract version replaces this fixture, its test expectations and the recipe's pinned version in one change.

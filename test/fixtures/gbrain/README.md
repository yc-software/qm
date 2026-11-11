# gbrain's QM memory provider contracts

QM vendors gbrain's machine-readable contracts for the tools it calls, one file per contract version: their input schemas, the `x-qm-actor` rules, the answer shapes and every refusal code with its class.

- `qm-memory-provider-v1.json` covers `memory_recall` and `memory_write`, which the [gbrain recipe](../../../docs/memory-providers.md#gbrain) and registry brains on the `gbrain-v1` preset call.
- `qm-memory-provider-v3.json` keeps those two tools and adds the personal tools QM may call in a person's own DM, such as `forget_fact`. Registry brains on the `gbrain-v3` preset call it.

[`test/gbrain-memory-provider.test.ts`](../../gbrain-memory-provider.test.ts) serves these tools from a fake gbrain and checks that QM sends requests the schemas accept and records each answer and refusal as the contract classes it.

| File                         | Source in [garrytan/gbrain](https://github.com/garrytan/gbrain) | Tagged release              | SHA-256                                                            |
| ---------------------------- | --------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `qm-memory-provider-v1.json` | `docs/contracts/qm-memory-provider/v1.json`                     | `v0.60.555.0` at `a3f46d35` | `c80a7a5f8133f875ef90a2b5052a53c4d2bb0ab95facfa3975ba626c00daae78` |
| `qm-memory-provider-v3.json` | `docs/contracts/qm-memory-provider/v3.json`                     | `v0.60.655.0` at `79781ec0` | `2a72688987f0b6d5179b2ebdd6de7fcbb8e5ae13ba09c5b4b8e6a0f7aa48f5ad` |

Each file is gbrain's bytes, unchanged, so `sha256sum <file>` proves which release it came from. Prettier skips them for that reason.

## Updating to a new gbrain release

gbrain never changes a published contract file, so a new contract version is a new file.

1. Copy `docs/contracts/qm-memory-provider/v<N>.json` from the release tag to `qm-memory-provider-v<N>.json` without reformatting it, and list it in `.prettierignore`.
2. Add its row to the table above with the tag, its commit and its `sha256sum`, and update the gbrain line under "Pinned versions" in [docs/memory-providers.md](../../../docs/memory-providers.md#gbrain) when the recipe moves to it.
3. Run `node --test test/gbrain-memory-provider.test.ts`. A failure names the request field or outcome that no longer matches; fix QM or the recipe, never the fixture.
4. Repeat the recipe's [Verify](../../../docs/memory-providers.md#verify) steps against a brain running that release.

A file stays while a preset or the recipe still targets its version, so a brain can move back to the older preset on a rollback. Remove it in the change that removes the last preset that uses it.

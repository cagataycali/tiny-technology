# Contributing to tiny

Thanks for wanting to make tiny better. This page is the practical guide; each
surface has its own README with deeper setup:
[web](web/README.md) · [worker](worker/README.md) · [chain](chain/README.md) ·
[ios](ios/README.md) · [android](android/README.md) · docs site sources in
[docs/](docs/).

## Getting a working tree

```bash
git clone https://github.com/cagataycali/tiny-technology.git
cd tiny-technology

# The two npm surfaces — this exact sequence is what CI runs:
(cd worker && npm ci)     # first: the web suite imports the worker's sources
(cd web && npm ci && npm run build && npm test)
```

That should end with every test green on a fresh clone. If it doesn't, that's
a bug — please open an issue before anything else.

Mobile:

- **iOS** — `cd ios && xcodegen generate`, then build the `Tiny` scheme for a
  simulator. On a device, `scripts/build-on-device.sh` finds your team and
  retargets bundle ids automatically (see [BUILD_ON_DEVICE.md](ios/BUILD_ON_DEVICE.md)).
- **Android** — needs JDK 21 and an Android SDK (API 35). Unit tests:
  `./gradlew :app:testDebugUnitTest` (scope to `:app:` — the `:wear` module has
  no JVM tests).

## Before you open a PR

- **Run the suite that owns your change.** Web/worker changes: `cd web && npm
  test` (the suite also reads worker, chain, ios and android sources — the
  cross-surface parity tests are deliberate). Android: the gradle command above.
  iOS: build + test the `Tiny` scheme.
- **Typecheck both trees**: `cd web && npm run typecheck` and `cd worker && npm
  run typecheck` (both are `tsc --noEmit`). Green tests are not green types:
  vitest strips types rather than checking them, and `next build` only visits
  files reachable from a route — so nothing in `web/tests/` is typechecked by
  either one.
- **CI runs the fresh-clone path on every PR** (`.github/workflows/ci.yml`),
  and docs changes get a strict `mkdocs build` (`docs.yml`). A PR that's red
  there won't be reviewed.
- **Keep tests hermetic.** Tests must not depend on your machine's state — no
  reads of your real `$HOME`, no assumption that a tool is installed, no
  network. If a fixture needs a binary or an artifact, stub it or `skipIf` it
  with the reads themselves guarded (vitest executes `describe` bodies even
  for skipped suites).
- **User-facing copy is cross-client.** The same message often exists in web,
  iOS and Android. If you change one, change all three — and when a test and
  its code disagree about copy, the tiebreak is what the *other* clients
  render, not whichever file is newer.
- **Don't commit machine or deployment state.** No binaries (releases go
  through GitHub Releases or the OTA scripts), no generated manifests, no
  `.env` files, no credentials of any kind — `.env.example` documents every
  variable with placeholders. `wrangler.toml` ships with `replace-with-your-*`
  ids on purpose.
- **Don't remove the symlinks under `web/`** (`chain`, `worker`, `ios`,
  `android`, `docs`, `mkdocs.yml`). The parity tests resolve repo files
  through them.

## Style

Match what's around you. Comments explain *why* (constraints, invariants,
failure modes the code guards against) — this codebase leans on that heavily;
read a few files first. Commit messages: a short scoped subject
(`fix(worker): …`, `docs(ios): …`) and a body that says what would break
without the change.

## License

By contributing you agree your contributions are licensed under the
repository's [Apache-2.0 license](LICENSE).

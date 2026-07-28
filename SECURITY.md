# Security policy

## Reporting a vulnerability

- **Sensitive findings** (anything exploitable — auth bypass, sandbox escape,
  SSRF, key exposure): use GitHub's **private vulnerability reporting** on
  this repository (Security tab → Report a vulnerability). Please don't open
  a public issue for these.
- **Hardening suggestions** and non-exploitable weaknesses: a normal GitHub
  issue is fine.

This is a free platform run by one person — a clear reproduction (exact
request, expected vs. actual) is the most valuable thing you can include.
You'll get a response as fast as one person can reasonably give one; there
is no bug bounty.

## Scope

Everything in this repository: the web app (`web/`), the worker (`worker/`),
the chain tooling (`chain/`), the mobile apps (`ios/`, `android/`), and the
CLI (`tiny-tech/`). If you're testing against the hosted service at
tiny.technology, keep it to your own account and data.

## Where the boundaries are

[`web/SECURITY.md`](web/SECURITY.md) is the detailed map contributors work
from: every place untrusted input enters (sessions, user-forged tool
execution, server fetches of user URLs, cross-tenant skills, prompt-injection
containment), the mechanism guarding it, and the test file that pins it. If
you touch a boundary, touch its tests.

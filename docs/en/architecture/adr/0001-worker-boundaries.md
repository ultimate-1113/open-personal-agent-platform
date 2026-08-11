# ADR 0001: Worker boundaries

[日本語](../../../ja/architecture/adr/0001-worker-boundaries.md)

## Status

Accepted

## Decision

Deploy Assistant, Public, Delegated, Control, and Gatekeeper as separate Workers.
Prevent access from the Public plane to private resources through absent bindings, not authorization code alone.

## Consequences

The deployment has more components, but configuration removes paths that could expose credentials or private memory.

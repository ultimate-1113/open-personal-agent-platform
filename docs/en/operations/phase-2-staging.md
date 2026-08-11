# Phase 2 staging validation

[日本語](../../ja/operations/phase-2-staging.md)

Run Phase 2 staging validation on Cloudflare Workers Paid only after mock CI passes.
Never commit real credentials or generated resource IDs.

## Prerequisites

```bash
pnpm install --frozen-lockfile
pnpm check
```

Use staging-specific D1 databases, Durable Object namespaces, AI Gateway, and Access application.
Apply `migrations/control` to Control D1.

## Deployment values

- `OWNER_EMAIL`: deployment owner's email
- `ACCESS_ISSUER`: Cloudflare Access issuer
- `ACCESS_AUDIENCE`: Access application audience tag
- `ACCESS_JWKS_URI`: Access JWKS endpoint
- `AI_GATEWAY_ID`: staging gateway with payload logging disabled
- `WORKERS_AI_MODEL`: Workers AI model ID registered in the price catalog

`OWNER_EMAIL` is used only for first bootstrap matching.
Later authorization uses JWT issuer and subject.

## Owner vertical test

1. Authenticate through Access and confirm that a non-owner JWT receives `403`.
2. Create a conversation with Mock Local Provider and save a message, task, and memory.
3. Select Workers AI and explicitly permit normal data transfer.
4. Save a Workers AI response and verify neuron and overage usage.
5. Set the AI budget to `0 USD` and verify `AI_SPEND_LIMIT_REACHED` after free usage is exhausted.
6. Replay the same `Idempotency-Key` and verify that the model does not run again.
7. Verify that an AI Gateway Spend Limit denial does not switch providers.
8. Switch between Japanese and English, then light and dark themes, and verify that both choices persist after reload.

## Evidence

Evidence may include secret-free CI results, Worker binding lists, Owner UI screenshots, and negative test results.
Never include Access JWTs, message bodies, prompts, OAuth tokens, or Cloudflare API tokens.

## Cost guarantee boundary

Application reservations limit AI work initiated by this deployment.
They cannot control free neurons used by another Worker in the account or requests metered before Worker code executes.
Use an AI Gateway Spend Limit and Cloudflare Account Budget Alerts as secondary controls.

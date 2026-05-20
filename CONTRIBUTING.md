# Contributing

## Development

- **Branch naming:** `feat/short-description`, `fix/short-description`, `docs/short-description`
- **Commit format:** `type: concise description`
- **PRs:** Link to the issue, describe the change, paste before/after test output

## Building and deploying

```bash
# Install AlgoKit
npm install -g @algorandfoundation/algokit-cli

# Build all contracts
cd projects/irion-contracts
algokit project run build

# Deploy to testnet
npx tsx scripts/deploy-all.ts --network testnet
```

## Testing

```bash
# Unit tests
npm test

# Integration tests against deployed testnet
npm run test:integration
```

## Code style

- PuyaTS (Algorand TypeScript), not TEALScript or PyTEAL
- Every `@abimethod` has a clear ARC-4 signature
- Box storage for all per-user/per-loan state (not global state)
- Cross-contract calls use `Global.callerApplicationId` assertions

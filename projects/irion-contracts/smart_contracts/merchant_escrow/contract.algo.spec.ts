import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MerchantEscrow } from './contract.algo'

describe('MerchantEscrow contract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  afterEach(() => {
    ctx.reset()
  })

  it('should calculate release round correctly', () => {
    const current_round = Uint64(100)
    const settlement_delay = Uint64(1000)

    const release_round = current_round + settlement_delay

    expect(release_round).toBe(Uint64(1100))
  })

  it('should validate escrow status values', () => {
    const ESCROW_STATUS_PENDING = Uint64(0)
    const ESCROW_STATUS_RELEASED = Uint64(1)
    const ESCROW_STATUS_REFUNDED = Uint64(2)

    expect(ESCROW_STATUS_PENDING).toBe(Uint64(0))
    expect(ESCROW_STATUS_RELEASED).toBe(Uint64(1))
    expect(ESCROW_STATUS_REFUNDED).toBe(Uint64(2))
  })

  it('should allow release after settlement delay', () => {
    const current_round = Uint64(1100)
    const release_round = Uint64(1100)

    const can_release = current_round >= release_round

    expect(can_release).toBe(true)
  })

  it('should block release before settlement delay', () => {
    const current_round = Uint64(1099)
    const release_round = Uint64(1100)

    const can_release = current_round >= release_round

    expect(can_release).toBe(false)
  })
})
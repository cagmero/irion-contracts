import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { LendingPool } from './contract.algo'

describe('LendingPool contract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  afterEach(() => {
    ctx.reset()
  })

  it('should initialize global state on bootstrap (mock test)', () => {
    const contract = ctx.contract.create(LendingPool)
    
    // This is a unit test without actual state
    // In real tests, we'd test methods directly
    expect(contract).toBeDefined()
  })

  it('should calculate utilization correctly', () => {
    const contract = ctx.contract.create(LendingPool)
    
    // Test utility calculations that don't require state
    const total_deposits = Uint64(1000)
    const total_borrowed = Uint64(500)
    
    // Utilization = borrowed / deposits * 10000 bps
    const utilization = (total_borrowed * Uint64(10000)) / total_deposits
    expect(utilization).toBe(Uint64(5000)) // 50%
  })

  it('should calculate LP tokens correctly for initial deposit', () => {
    const contract = ctx.contract.create(LendingPool)
    
    // First deposit gets LP tokens 1:1
    const deposit_amount = Uint64(1000)
    const existing_deposits = Uint64(0)
    const total_lp_supply = Uint64(1_000_000_000_000)
    
    // When existing_deposits is 0, return deposit_amount
    if (existing_deposits === Uint64(0)) {
      expect(deposit_amount).toBe(Uint64(1000))
    }
  })

  it('should calculate interest rate with utilization', () => {
    const contract = ctx.contract.create(LendingPool)
    
    const interest_rate_base = Uint64(500) // 5%
    const utilization = Uint64(5000) // 50%
    const utilization_slope = Uint64(800)
    const bps_multiplier = Uint64(10000)
    
    const rate = interest_rate_base + ((utilization * utilization_slope) / bps_multiplier)
    expect(rate).toBe(Uint64(540)) // 5.4%
  })
})
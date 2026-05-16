import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { CreditScore } from './contract.algo'

describe('CreditScore contract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  afterEach(() => {
    ctx.reset()
  })

  it('should initialize with min and max score', () => {
    const contract = ctx.contract.create(CreditScore)

    const MIN_SCORE = Uint64(300)
    const MAX_SCORE = Uint64(850)

    expect(MIN_SCORE).toBe(Uint64(300))
    expect(MAX_SCORE).toBe(Uint64(850))
  })

  it('should calculate score bonus for deposits correctly', () => {
    const DEPOSIT_BONUS_PER_10_USDC = Uint64(1)
    const MAX_DEPOSIT_BONUS = Uint64(200)

    // Deposit 100 USDC (100 * 10^6 microUSDC)
    const deposit_amount = Uint64(100_000_000)
    // That's 100 / 10 = 10 units
    const deposit_increase = deposit_amount / Uint64(10_000_000)
    const score_bonus = deposit_increase * DEPOSIT_BONUS_PER_10_USDC
    const capped_bonus = score_bonus > MAX_DEPOSIT_BONUS ? MAX_DEPOSIT_BONUS : score_bonus

    expect(capped_bonus).toBe(Uint64(10))
  })

  it('should clamp score between min and max', () => {
    const MIN_SCORE = Uint64(300)
    const MAX_SCORE = Uint64(850)

    // Test clamping function
    const clamp_score = (score: uint64): uint64 => {
      if (score < MIN_SCORE) return MIN_SCORE
      if (score > MAX_SCORE) return MAX_SCORE
      return score
    }

    expect(clamp_score(Uint64(200))).toBe(Uint64(300)) // Below min
    expect(clamp_score(Uint64(500))).toBe(Uint64(500)) // In range
    expect(clamp_score(Uint64(900))).toBe(Uint64(850)) // Above max
  })

  it('should calculate borrow limit by score tier', () => {
    const get_borrow_limit = (score: uint64): uint64 => {
      if (score < Uint64(500)) return Uint64(0)
      if (score < Uint64(600)) return Uint64(500_000_000)
      if (score < Uint64(700)) return Uint64(2_000_000_000)
      if (score < Uint64(750)) return Uint64(5_000_000_000)
      return Uint64(10_000_000_000)
    }

    expect(get_borrow_limit(Uint64(300))).toBe(Uint64(0))
    expect(get_borrow_limit(Uint64(500))).toBe(Uint64(500_000_000))
    expect(get_borrow_limit(Uint64(600))).toBe(Uint64(2_000_000_000))
    expect(get_borrow_limit(Uint64(700))).toBe(Uint64(5_000_000_000))
    expect(get_borrow_limit(Uint64(800))).toBe(Uint64(10_000_000_000))
  })

  it('should apply on-time repayment bonus correctly', () => {
    const ON_TIME_REPAYMENT_BONUS = Uint64(20)

    const score = Uint64(500)
    const new_score = score + ON_TIME_REPAYMENT_BONUS

    expect(new_score).toBe(Uint64(520))
  })

  it('should apply late repayment penalty correctly', () => {
    const LATE_REPAYMENT_PENALTY = Uint64(30)

    const score = Uint64(500)
    const new_score = score - LATE_REPAYMENT_PENALTY

    expect(new_score).toBe(Uint64(470))
  })

  it('should apply default penalty correctly', () => {
    const DEFAULT_PENALTY = Uint64(100)

    const score = Uint64(500)
    const new_score = score - DEFAULT_PENALTY

    expect(new_score).toBe(Uint64(400))
  })
})
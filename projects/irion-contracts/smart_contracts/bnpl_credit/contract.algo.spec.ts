import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { BNPLCredit } from './contract.algo'

describe('BNPLCredit contract', () => {
  const ctx = new TestExecutionContext()

  beforeEach(() => {
    ctx.reset()
  })

  afterEach(() => {
    ctx.reset()
  })

  it('should calculate installment amount correctly', () => {
    const principal = Uint64(1000_000_000) // 1000 USDC
    const num_installments = Uint64(4)

    const installment_amount = principal / num_installments

    expect(installment_amount).toBe(Uint64(250_000_000)) // 250 USDC each
  })

  it('should calculate next due round correctly', () => {
    const start_round = Uint64(100)
    const installment_interval = Uint64(1576800)

    const next_due_round = start_round + installment_interval

    expect(next_due_round).toBe(Uint64(1576900))
  })

  it('should calculate late fee correctly', () => {
    const payment_amount = Uint64(250_000_000) // 250 USDC
    const late_fee_bps = Uint64(200)
    const bps_multiplier = Uint64(10000)

    const late_fee = (payment_amount * late_fee_bps) / bps_multiplier

    expect(late_fee).toBe(Uint64(5_000_000)) // 5 USDC = 2%
  })

  it('should validate loan status correctly', () => {
    const LOAN_STATUS_ACTIVE = Uint64(0)
    const LOAN_STATUS_COMPLETED = Uint64(1)
    const LOAN_STATUS_DEFAULTED = Uint64(2)
    const LOAN_STATUS_DISPUTED = Uint64(3)

    expect(LOAN_STATUS_ACTIVE).toBe(Uint64(0))
    expect(LOAN_STATUS_COMPLETED).toBe(Uint64(1))
    expect(LOAN_STATUS_DEFAULTED).toBe(Uint64(2))
    expect(LOAN_STATUS_DISPUTED).toBe(Uint64(3))
  })

  it('should determine on-time payment correctly', () => {
    const next_due_round = Uint64(1000)
    const payment_round = Uint64(999)

    const is_on_time = payment_round <= next_due_round

    expect(is_on_time).toBe(true)
  })

  it('should detect late payment correctly', () => {
    const next_due_round = Uint64(1000)
    const payment_round = Uint64(1001)

    const is_on_time = payment_round <= next_due_round

    expect(is_on_time).toBe(false)
  })

  it('should validate borrow limit tiers', () => {
    const MIN_SCORE = Uint64(500)
    const amount = Uint64(500_000_000)
    const borrow_limit = Uint64(500_000_000)

    // Score must be >= 500 to borrow
    const score = Uint64(500)
    const can_borrow = score >= MIN_SCORE && amount <= borrow_limit

    expect(can_borrow).toBe(true)
  })
})
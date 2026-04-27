import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { defineAction } from '../src/action.js'
import { Client } from '../src/client.js'
import { JOB_STATUS_COMPLETED } from '../src/constants.js'
import { z } from 'zod'

import { pgliteFactory } from './adapters.js'

// Test version of processOrder without AI dependency
const testProcessOrder = defineAction()({
  name: 'processOrder',
  input: z.object({
    orderId: z.string().min(1),
    customerId: z.string().min(1),
    items: z
      .array(
        z.object({
          productId: z.string(),
          quantity: z.number().min(1),
          price: z.number().min(0),
        }),
      )
      .min(1),
    paymentMethod: z.enum(['credit_card', 'paypal', 'bank_transfer']).default('credit_card'),
    shippingAddress: z.object({
      street: z.string(),
      city: z.string(),
      country: z.string(),
      postalCode: z.string(),
    }),
  }),
  output: z.object({
    orderId: z.string(),
    status: z.enum(['completed', 'failed']),
    transactionId: z.string().nullable(),
    shipmentId: z.string().nullable(),
    timeline: z.array(
      z.object({
        step: z.string(),
        status: z.enum(['success', 'failed']),
        timestamp: z.string(),
        details: z.string().optional(),
      }),
    ),
  }),
  steps: {
    concurrency: 10,
    retry: {
      limit: 1,
    },
  },
  handler: async (ctx) => {
    const { orderId, customerId, items, shippingAddress } = ctx.input
    const timeline: Array<{
      step: string
      status: 'success' | 'failed'
      timestamp: string
      details?: string
    }> = []
    const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0)

    const addTimeline = (step: string, status: 'success' | 'failed', details?: string) => {
      timeline.push({ step, status, timestamp: new Date().toISOString(), details })
    }

    // Step 1: Validate Order
    const validation = await ctx.step('validate-order', async ({ step: nestedStep }) => {
      const inventoryCheck = await nestedStep('check-inventory', async () => {
        const allInStock = items.every((item) => item.quantity <= 10)
        addTimeline('check-inventory', allInStock ? 'success' : 'failed', `Checked ${items.length} items`)
        return { allInStock, checkedItems: items.length }
      })

      const customerVerification = await nestedStep('verify-customer', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const isValid = customerId.length > 0
        addTimeline('verify-customer', isValid ? 'success' : 'failed', `Customer: ${customerId}`)
        return { isValid, customerId }
      })

      addTimeline(
        'validate-order',
        inventoryCheck.allInStock && customerVerification.isValid ? 'success' : 'failed',
        `Inventory: ${inventoryCheck.allInStock}, Customer: ${customerVerification.isValid}`,
      )

      return {
        isValid: inventoryCheck.allInStock && customerVerification.isValid,
        inventoryCheck,
        customerVerification,
      }
    })

    if (!validation.isValid) {
      return {
        orderId,
        status: 'failed' as const,
        transactionId: null,
        shipmentId: null,
        timeline,
      }
    }

    // Step 2: Process Payment
    const payment = await ctx.step(
      'process-payment',
      async ({ step: paymentStep }) => {
        const authorization = await paymentStep('authorize-payment', async ({ step: authStep }) => {
          const fraudCheck = await authStep('fraud-check', async () => {
            await new Promise((resolve) => setTimeout(resolve, 50))
            const isSafe = totalAmount < 10000
            addTimeline('fraud-check', isSafe ? 'success' : 'failed', `Amount: $${totalAmount.toFixed(2)}`)
            return { isSafe, riskScore: isSafe ? 0.1 : 0.9 }
          })

          if (!fraudCheck.isSafe) {
            addTimeline('authorize-payment', 'failed', 'Fraud check failed')
            return { authorized: false, authCode: null, fraudCheck }
          }

          await new Promise((resolve) => setTimeout(resolve, 50))
          const authCode = `AUTH-${Date.now()}`
          addTimeline('authorize-payment', 'success', `Auth code: ${authCode}`)
          return { authorized: true, authCode, fraudCheck }
        })

        if (!authorization.authorized) {
          addTimeline('process-payment', 'failed', 'Authorization failed')
          return { success: false, transactionId: null, authorization }
        }

        const capture = await paymentStep('capture-payment', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          const transactionId = `TXN-${Date.now()}`
          addTimeline('capture-payment', 'success', `Transaction: ${transactionId}`)
          return { captured: true, transactionId }
        })

        addTimeline('process-payment', 'success', `Transaction ID: ${capture.transactionId}`)
        return {
          success: true,
          transactionId: capture.transactionId,
          authorization,
        }
      },
      { expire: 60_000 },
    )

    if (!payment.success) {
      return {
        orderId,
        status: 'failed' as const,
        transactionId: null,
        shipmentId: null,
        timeline,
      }
    }

    // Step 3: Fulfill Order
    const fulfillment = await ctx.step('fulfill-order', async ({ step: fulfillStep }) => {
      const reservation = await fulfillStep('reserve-inventory', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const reservationId = `RES-${Date.now()}`
        addTimeline('reserve-inventory', 'success', `Reserved ${items.length} items`)
        return { reserved: true, reservationId }
      })

      const shipment = await fulfillStep('create-shipment', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const shipmentId = `SHIP-${Date.now()}`
        addTimeline('create-shipment', 'success', `Shipment to ${shippingAddress.city}`)
        return { shipmentId, carrier: 'FastShip', estimatedDays: 3 }
      })

      addTimeline('fulfill-order', 'success', `Shipment: ${shipment.shipmentId}`)
      return { reservation, shipment }
    })

    // Step 4: Send Notifications
    await ctx.step('send-notifications', async ({ step: notifyStep }) => {
      const [emailResult, smsResult] = await Promise.all([
        notifyStep('email-confirmation', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          addTimeline('email-confirmation', 'success', `Sent to customer ${customerId}`)
          return { sent: true, type: 'email' }
        }),
        notifyStep('sms-notification', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          addTimeline('sms-notification', 'success', 'Order confirmation SMS sent')
          return { sent: true, type: 'sms' }
        }),
      ])

      addTimeline('send-notifications', 'success', `Email: ${emailResult.sent}, SMS: ${smsResult.sent}`)
      return { email: emailResult, sms: smsResult }
    })

    // Step 5: Post-Order Processing (Promise.all of steps)
    await ctx.step('post-order-processing', async (ctx) => {
      await Promise.all([
        ctx.step(
          'analytics-tracking',
          async ({ step: analyticsStep }) => {
            const purchase = await analyticsStep('track-purchase', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              addTimeline('track-purchase', 'success', `Tracked order ${orderId}`)
              return { eventId: `EVT-${Date.now()}`, type: 'purchase' }
            })

            const recommendations = await analyticsStep('update-recommendations', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              addTimeline('update-recommendations', 'success', `Updated for ${items.length} products`)
              return { updated: true, productsAnalyzed: items.length }
            })

            addTimeline('analytics-tracking', 'success', 'Analytics updated')
            return { purchase, recommendations }
          },
          { parallel: true },
        ),

        ctx.step(
          'loyalty-update',
          async ({ step: loyaltyStep }) => {
            const points = await loyaltyStep('calculate-points', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              const earnedPoints = Math.floor(totalAmount * 10)
              addTimeline('calculate-points', 'success', `Earned ${earnedPoints} points`)
              return { earnedPoints, multiplier: 1.0 }
            })

            const tier = await loyaltyStep('update-tier', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              const newTier = totalAmount > 500 ? 'gold' : totalAmount > 100 ? 'silver' : 'bronze'
              addTimeline('update-tier', 'success', `Tier: ${newTier}`)
              return { tier: newTier, upgraded: totalAmount > 500 }
            })

            addTimeline('loyalty-update', 'success', `${points.earnedPoints} points, tier: ${tier.tier}`)
            return { points, tier }
          },
          { parallel: true },
        ),

        ctx.step(
          'partner-sync',
          async ({ step: syncStep }) => {
            const supplier = await syncStep('sync-supplier', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              addTimeline('sync-supplier', 'success', 'Supplier inventory updated')
              return { synced: true, supplierId: 'SUP-001' }
            })

            const warehouse = await syncStep('sync-warehouse', async () => {
              await new Promise((resolve) => setTimeout(resolve, 50))
              addTimeline('sync-warehouse', 'success', 'Warehouse notified for picking')
              return { synced: true, warehouseId: 'WH-MAIN' }
            })

            addTimeline('partner-sync', 'success', 'All partners synced')
            return { supplier, warehouse }
          },
          { parallel: true },
        ),
      ])

      return { success: true }
    })

    return {
      orderId,
      status: 'completed' as const,
      transactionId: payment.transactionId,
      shipmentId: fulfillment.shipment.shipmentId,
      timeline,
    }
  },
})

describe('processOrder Action', () => {
  let client: Client<any>

  beforeEach(async () => {
    const { adapter } = await pgliteFactory.create()
    adapter.setId('test-adapter')
    await adapter.start()

    client = new Client({
      id: 'test-client',
      database: adapter,
      actions: {
        processOrder: testProcessOrder,
      },
    })

    await client.start()
  })

  afterEach(async () => {
    if (client) {
      await client.stop()
    }
  })

  it('should process order successfully', async () => {
    const result = await client.runActionAndWait('processOrder', {
      orderId: 'ORD-123',
      customerId: 'CUST-456',
      items: [
        { productId: 'PROD-1', quantity: 2, price: 29.99 },
        { productId: 'PROD-2', quantity: 1, price: 49.99 },
      ],
      paymentMethod: 'credit_card',
      shippingAddress: {
        street: '123 Main St',
        city: 'New York',
        country: 'USA',
        postalCode: '10001',
      },
    })

    expect(result.status).toBe(JOB_STATUS_COMPLETED)
    expect(result.output.status).toBe('completed')
    expect(result.output.orderId).toBe('ORD-123')
    expect(result.output.transactionId).not.toBeNull()
    expect(result.output.shipmentId).not.toBeNull()
    expect(result.output.timeline.length).toBeGreaterThan(0)
  })

  it('should have correct timeline entries', async () => {
    const result = await client.runActionAndWait('processOrder', {
      orderId: 'ORD-456',
      customerId: 'CUST-789',
      items: [{ productId: 'PROD-3', quantity: 1, price: 99.99 }],
      paymentMethod: 'paypal',
      shippingAddress: {
        street: '456 Oak Ave',
        city: 'Los Angeles',
        country: 'USA',
        postalCode: '90001',
      },
    })

    expect(result.output.timeline).toBeDefined()
    expect(result.output.timeline.length).toBeGreaterThanOrEqual(10)

    const steps = result.output.timeline.map((t) => t.step)
    expect(steps).toContain('check-inventory')
    expect(steps).toContain('verify-customer')
    expect(steps).toContain('validate-order')
    expect(steps).toContain('fraud-check')
    expect(steps).toContain('authorize-payment')
    expect(steps).toContain('capture-payment')
    expect(steps).toContain('process-payment')
    expect(steps).toContain('reserve-inventory')
    expect(steps).toContain('create-shipment')
    expect(steps).toContain('fulfill-order')
    expect(steps).toContain('email-confirmation')
    expect(steps).toContain('sms-notification')
    expect(steps).toContain('send-notifications')
  })

  it('should fail when inventory is not available', async () => {
    const result = await client.runActionAndWait('processOrder', {
      orderId: 'ORD-789',
      customerId: 'CUST-999',
      items: [
        { productId: 'PROD-4', quantity: 20, price: 10 }, // quantity > 10 should fail
      ],
      paymentMethod: 'credit_card',
      shippingAddress: {
        street: '789 Pine Rd',
        city: 'Chicago',
        country: 'USA',
        postalCode: '60001',
      },
    })

    expect(result.status).toBe(JOB_STATUS_COMPLETED)
    expect(result.output.status).toBe('failed')
    expect(result.output.transactionId).toBeNull()
    expect(result.output.shipmentId).toBeNull()
  })
})

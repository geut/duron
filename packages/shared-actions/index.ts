import { openai } from "@ai-sdk/openai";
import { context, trace } from "@opentelemetry/api";
import { generateText } from "ai";
import { defineAction, NonRetriableError } from "duron/index";
import * as z from "zod";

export const variables = {
  sendEmail: async (
    args: { email: string; subject: string; body: string; timeout: number },
    signal: AbortSignal,
  ) => {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, args.timeout);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });

    return {
      success: true,
    };
  },
  getWeather: async (args: { city: string }, signal: AbortSignal) => {
    // Using Open-Meteo API (free, no API key required)
    const controller = new AbortController();
    signal.addEventListener("abort", () => controller.abort());

    // First, geocode the city name to get coordinates
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.city)}&count=1&language=en&format=json`;
    const geocodeResponse = await fetch(geocodeUrl, {
      signal: controller.signal,
    });

    if (!geocodeResponse.ok) {
      throw new NonRetriableError(
        `Geocoding API error: ${geocodeResponse.status} ${geocodeResponse.statusText}`,
      );
    }

    const geocodeData = (await geocodeResponse.json()) as {
      results?: Array<{
        latitude: number;
        longitude: number;
        name: string;
        country_code: string;
      }>;
    };

    if (!geocodeData.results || geocodeData.results.length === 0) {
      throw new NonRetriableError(`City "${args.city}" not found`);
    }

    const firstResult = geocodeData.results[0];
    if (!firstResult) {
      throw new NonRetriableError(`City "${args.city}" not found`);
    }

    const { latitude, longitude, name, country_code } = firstResult;

    // Then, fetch current weather data using coordinates
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,pressure_msl,weather_code,wind_speed_10m,visibility&timezone=auto`;
    const weatherResponse = await fetch(weatherUrl, {
      signal: controller.signal,
    });

    if (!weatherResponse.ok) {
      throw new NonRetriableError(
        `Weather API error: ${weatherResponse.status} ${weatherResponse.statusText}`,
      );
    }

    const weatherData = (await weatherResponse.json()) as {
      current: {
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        pressure_msl: number;
        weather_code: number;
        wind_speed_10m: number;
        visibility: number | null;
      };
    };
    const current = weatherData.current;

    // Map weather codes to descriptions (simplified)
    const weatherDescriptions: Record<number, string> = {
      0: "Clear sky",
      1: "Mainly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Foggy",
      48: "Depositing rime fog",
      51: "Light drizzle",
      53: "Moderate drizzle",
      55: "Dense drizzle",
      56: "Light freezing drizzle",
      57: "Dense freezing drizzle",
      61: "Slight rain",
      63: "Moderate rain",
      65: "Heavy rain",
      71: "Slight snow fall",
      73: "Moderate snow fall",
      75: "Heavy snow fall",
      77: "Snow grains",
      80: "Slight rain showers",
      81: "Moderate rain showers",
      82: "Violent rain showers",
      85: "Slight snow showers",
      86: "Heavy snow showers",
      95: "Thunderstorm",
      96: "Thunderstorm with slight hail",
      99: "Thunderstorm with heavy hail",
    };

    return {
      city: name,
      country: country_code,
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      pressure: current.pressure_msl,
      description: weatherDescriptions[current.weather_code] || "Unknown",
      windSpeed: current.wind_speed_10m,
      visibility: current.visibility ? current.visibility / 1000 : null, // Convert to km
    };
  },
};

export const sendEmail = defineAction<typeof variables>()({
  name: "sendEmail",
  description: async (ctx) => `Send email to ${ctx.input.email}`,
  groups: {
    groupKey: async (ctx) => `email=${ctx.input.email}`,
    concurrency: async () => 2,
  },
  input: z.object({
    email: z.email(),
    subject: z.string(),
    body: z.string(),
    timeout: z.number().min(1000).max(60_000).default(4000),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  handler: async (ctx) => {
    const { email, subject, body } = ctx.input;

    const { success } = await ctx.step(
      `send email to ${email}`,
      async ({ signal }) => {
        return ctx.var.sendEmail({ email, subject, body, timeout: ctx.input.timeout }, signal);
      },
      {
        expire: 6_000,
      },
    );

    return {
      success,
    };
  },
});

export const getWeather = defineAction<typeof variables>()({
  name: "getWeather",
  input: z.object({
    city: z.string().min(1).describe("The city name to get weather for"),
  }),
  output: z.object({
    niceMessage: z.string().describe("A nice message for the weather"),
    info: z.object({
      city: z.string().describe("City name"),
      country: z.string().describe("Country code"),
      temperature: z.number().describe("Temperature in Celsius"),
      feelsLike: z.number().describe("Feels like temperature in Celsius"),
      humidity: z.number().describe("Humidity percentage"),
      pressure: z.number().describe("Atmospheric pressure in hPa"),
    }),
  }),
  handler: async (ctx) => {
    const { city } = ctx.input;

    const weather = await ctx.step(
      `get weather for ${city}`,
      async ({ signal }) => {
        return ctx.var.getWeather({ city }, signal);
      },
      {
        expire: 10_000, // 10 seconds for weather API
      },
    );

    const niceMessage = await ctx.step(
      `generate nice message`,
      async (ctx) => {
        return generateText({
          prompt: `Generate a nice message for the weather in ${city} based on the following weather data: ${JSON.stringify(weather)}`,
          model: openai("gpt-4o-mini"),
          temperature: 1,
          abortSignal: ctx.signal,
          experimental_telemetry: {
            isEnabled: true,
            tracer: ctx.telemetry.getTracer("ai"),
          },
        });
      },
      {
        expire: 60_000, // 60 seconds for AI generation
      },
    );

    return {
      niceMessage: niceMessage.text,
      info: weather,
    };
  },
});

/**
 * Example action demonstrating nested steps feature.
 * This simulates an e-commerce order processing workflow with:
 * - Parent steps that contain child steps
 * - Deep nesting (3 levels)
 * - Shared abort signal propagation
 * - Parent-child step tracking in the database
 * - Promise.all of parent steps, each with their own nested children
 *
 * The workflow:
 * 1. validate-order (parent)
 *    ├── check-inventory (child)
 *    └── verify-customer (child)
 *
 * 2. process-payment (parent)
 *    ├── authorize-payment (child)
 *    │   └── fraud-check (grandchild - 3 levels deep!)
 *    └── capture-payment (child)
 *
 * 3. fulfill-order (parent)
 *    ├── reserve-inventory (child)
 *    └── create-shipment (child)
 *
 * 4. send-notifications (parent)
 *    ├── email-confirmation (child) ─┐
 *    └── sms-notification (child)  ──┴── concurrent child steps
 *
 * 5. post-order-processing (Promise.all of 3 parent steps with nested children)
 *    ├── analytics-tracking (parent) ─────┐
 *    │   ├── track-purchase (child)       │
 *    │   └── update-recommendations       │
 *    ├── loyalty-update (parent) ─────────┼── all 3 run in parallel
 *    │   ├── calculate-points (child)     │
 *    │   └── update-tier (child)          │
 *    └── partner-sync (parent) ───────────┘
 *        ├── sync-supplier (child)
 *        └── sync-warehouse (child)
 */
export const processOrder = defineAction<typeof variables>()({
  name: "processOrder",
  input: z.object({
    orderId: z.string().min(1).describe("The order ID to process"),
    customerId: z.string().min(1).describe("The customer ID"),
    items: z
      .array(
        z.object({
          productId: z.string(),
          quantity: z.number().min(1),
          price: z.number().min(0),
        }),
      )
      .min(1)
      .describe("Order items"),
    paymentMethod: z.enum(["credit_card", "paypal", "bank_transfer"]).default("credit_card"),
    shippingAddress: z.object({
      street: z.string(),
      city: z.string(),
      country: z.string(),
      postalCode: z.string(),
    }),
  }),
  output: z.object({
    orderId: z.string(),
    status: z.enum(["completed", "failed"]),
    transactionId: z.string().nullable(),
    shipmentId: z.string().nullable(),
    timeline: z.array(
      z.object({
        step: z.string(),
        status: z.enum(["success", "failed"]),
        timestamp: z.string(),
        details: z.string().optional(),
      }),
    ),
  }),
  steps: {
    concurrency: 10,
    // expire: 5_000,
    retry: {
      limit: 1,
    },
  },
  handler: async (ctx) => {
    const { orderId, customerId, items, paymentMethod, shippingAddress } = ctx.input;
    const timeline: Array<{
      step: string;
      status: "success" | "failed";
      timestamp: string;
      details?: string;
    }> = [];
    const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Helper to add timeline entry
    const addTimeline = (step: string, status: "success" | "failed", details?: string) => {
      timeline.push({ step, status, timestamp: new Date().toISOString(), details });
    };

    // =========================================================================
    // Step 1: Validate Order (with nested child steps)
    // =========================================================================
    const validation = await ctx.step("validate-order", async ({ step: nestedStep }) => {
      // Child step: Check inventory for all items
      // TELEMETRY EXAMPLE 1: Add attributes/events to the current span
      const inventoryCheck = await nestedStep("check-inventory", async (ctx) => {
        const allInStock = items.every((item) => item.quantity <= 10); // Mock: max 10 per item

        // Get the active span (this is the step:check-inventory span created by Duron)
        const span = ctx.telemetry.getActiveSpan();

        // Add attributes to the current span - these will appear in the span's attributes
        span?.setAttribute("inventory.allInStock", allInStock);
        span?.setAttribute("inventory.itemCount", items.length);
        span?.setAttribute("inventory.productIds", items.map((i) => i.productId).join(", "));

        // Add an event to the span - this will appear in the span's events array
        span?.addEvent("inventory-check-complete", {
          allInStock,
          checkedAt: new Date().toISOString(),
        });

        addTimeline(
          "check-inventory",
          allInStock ? "success" : "failed",
          `Checked ${items.length} items`,
        );
        return { allInStock, checkedItems: items.length };
      });

      // Child step: Verify customer
      // TELEMETRY EXAMPLE 2: Create a custom child span for sub-operations
      const customerVerification = await nestedStep("verify-customer", async (ctx) => {
        await Promise.all([
          ctx.step(
            "check ID",
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              return { success: true };
            },
            { parallel: true },
          ),
          ctx.step(
            "check image profile",
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 4_000));
              return { success: true };
            },
            { parallel: true },
          ),
        ]);

        // Get a tracer and create a child span for a specific sub-operation
        const tracer = ctx.telemetry.getTracer("customer-verification");

        // Get the parent context from the active span
        const parentSpan = ctx.telemetry.getActiveSpan();
        const parentContext = parentSpan
          ? trace.setSpan(context.active(), parentSpan)
          : context.active();

        // Create a child span - it will be properly linked to the parent step span
        const dbLookupSpan = tracer.startSpan(
          "database-lookup",
          {
            attributes: {
              "db.system": "postgresql",
              "db.operation": "SELECT",
              "customer.id": customerId,
            },
          },
          parentContext,
        );

        try {
          // Simulate customer verification (database lookup)
          await new Promise((resolve) => setTimeout(resolve, 80));
          const isValid = customerId.length > 0;

          dbLookupSpan.setAttribute("customer.verified", isValid);
          dbLookupSpan.addEvent("lookup-complete", { found: isValid });

          addTimeline("verify-customer", isValid ? "success" : "failed", `Customer: ${customerId}`);
          return { isValid, customerId };
        } finally {
          // Always end the span
          dbLookupSpan.end();
        }
      });

      addTimeline(
        "validate-order",
        inventoryCheck.allInStock && customerVerification.isValid ? "success" : "failed",
        `Inventory: ${inventoryCheck.allInStock}, Customer: ${customerVerification.isValid}`,
      );

      return {
        isValid: inventoryCheck.allInStock && customerVerification.isValid,
        inventoryCheck,
        customerVerification,
      };
    });

    if (!validation.isValid) {
      return {
        orderId,
        status: "failed" as const,
        transactionId: null,
        shipmentId: null,
        timeline,
      };
    }

    // =========================================================================
    // Step 2: Process Payment (with deeply nested steps - 3 levels)
    // =========================================================================
    const payment = await ctx.step(
      "process-payment",
      async ({ step: paymentStep }) => {
        // Child step: Authorize payment (contains grandchild step)
        const authorization = await paymentStep("authorize-payment", async ({ step: authStep }) => {
          // Grandchild step: Fraud check (3 levels deep!)
          // TELEMETRY EXAMPLE 3: Use recordMetric for simple metric events
          const fraudCheck = await authStep("fraud-check", async (ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const isSafe = totalAmount < 10000; // Mock: flag large orders
            const riskScore = isSafe ? 0.1 : 0.9;

            // Record metrics - these appear as events on the span with the metric value
            // Great for tracking numerical values like latency, counts, scores, etc.
            ctx.telemetry.recordMetric("fraud.amount.checked", totalAmount, {
              currency: "USD",
            });
            ctx.telemetry.recordMetric("fraud.risk.score", riskScore, {
              threshold: "0.5",
              result: isSafe ? "safe" : "flagged",
            });
            ctx.telemetry.recordMetric("fraud.processing.time.ms", 5000);

            addTimeline(
              "fraud-check",
              isSafe ? "success" : "failed",
              `Amount: $${totalAmount.toFixed(2)}`,
            );
            return { isSafe, riskScore };
          });

          if (!fraudCheck.isSafe) {
            addTimeline("authorize-payment", "failed", "Fraud check failed");
            return { authorized: false, authCode: null, fraudCheck };
          }

          await new Promise((resolve) => setTimeout(resolve, 100));
          const authCode = `AUTH-${Date.now()}`;
          addTimeline("authorize-payment", "success", `Auth code: ${authCode}`);
          return { authorized: true, authCode, fraudCheck };
        });

        if (!authorization.authorized) {
          addTimeline("process-payment", "failed", "Authorization failed");
          return { success: false, transactionId: null, authorization };
        }

        // Child step: Capture payment
        const capture = await paymentStep("capture-payment", async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const transactionId = `TXN-${Date.now()}`;
          addTimeline(
            "capture-payment",
            "success",
            `Transaction: ${transactionId}, Method: ${paymentMethod}`,
          );
          return { captured: true, transactionId };
        });

        addTimeline("process-payment", "success", `Transaction ID: ${capture.transactionId}`);
        return {
          success: true,
          transactionId: capture.transactionId,
          authorization,
        };
      },
      { expire: 60_000 },
    );

    if (!payment.success) {
      return {
        orderId,
        status: "failed" as const,
        transactionId: null,
        shipmentId: null,
        timeline,
      };
    }

    // =========================================================================
    // Step 3: Fulfill Order (with nested steps)
    // =========================================================================
    const fulfillment = await ctx.step("fulfill-order", async ({ step: fulfillStep }) => {
      // Child step: Reserve inventory
      const reservation = await fulfillStep("reserve-inventory", async () => {
        await new Promise((resolve) => setTimeout(resolve, 90));
        const reservationId = `RES-${Date.now()}`;
        addTimeline("reserve-inventory", "success", `Reserved ${items.length} items`);
        return { reserved: true, reservationId };
      });

      // Child step: Create shipment
      const shipment = await fulfillStep("create-shipment", async () => {
        await new Promise((resolve) => setTimeout(resolve, 110));
        const shipmentId = `SHIP-${Date.now()}`;
        addTimeline(
          "create-shipment",
          "success",
          `Shipment to ${shippingAddress.city}, ${shippingAddress.country}`,
        );
        return { shipmentId, carrier: "FastShip", estimatedDays: 3 };
      });

      addTimeline("fulfill-order", "success", `Shipment: ${shipment.shipmentId}`);
      return { reservation, shipment };
    });

    // =========================================================================
    // Step 4: Send Notifications (with concurrent nested steps)
    // =========================================================================
    await ctx.step("send-notifications", async ({ step: notifyStep }) => {
      // Run notification child steps concurrently
      const [emailResult, smsResult] = await Promise.all([
        // Child step: Send email confirmation
        notifyStep("email-confirmation", async () => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          addTimeline("email-confirmation", "success", `Sent to customer ${customerId}`);
          return { sent: true, type: "email" };
        }),

        // Child step: Send SMS notification
        notifyStep("sms-notification", async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          addTimeline("sms-notification", "success", "Order confirmation SMS sent");
          return { sent: true, type: "sms" };
        }),
      ]);

      addTimeline(
        "send-notifications",
        "success",
        `Email: ${emailResult.sent}, SMS: ${smsResult.sent}`,
      );
      return { email: emailResult, sms: smsResult };
    });

    const { analytics, loyalty, partnerSync } = await ctx.step(
      "post-order-processing",
      async (ctx) => {
        // =========================================================================
        // Step 5: Post-Order Processing (Promise.all of steps with nested steps)
        // This demonstrates running multiple parent steps in parallel,
        // where each parent step has its own nested child steps.
        // =========================================================================
        const [analytics, loyalty, partnerSync] = await Promise.all([
          // Parent step 1: Analytics Tracking (with nested steps)
          ctx.step(
            "analytics-tracking",
            async ({ step: analyticsStep }) => {
              // Nested child: Track purchase event
              const purchase = await analyticsStep("track-purchase", async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
                addTimeline("track-purchase", "success", `Tracked order ${orderId}`);
                return { eventId: `EVT-${Date.now()}`, type: "purchase" };
              });

              // Nested child: Update product recommendations
              const recommendations = await analyticsStep("update-recommendations", async () => {
                await new Promise((resolve) => setTimeout(resolve, 60));
                addTimeline(
                  "update-recommendations",
                  "success",
                  `Updated for ${items.length} products`,
                );
                return { updated: true, productsAnalyzed: items.length };
              });

              addTimeline("analytics-tracking", "success", "Analytics updated");
              return { purchase, recommendations };
            },
            { parallel: true },
          ),

          // Parent step 2: Loyalty Program Update (with nested steps)
          ctx.step(
            "loyalty-update",
            async ({ step: loyaltyStep }) => {
              // Nested child: Calculate loyalty points
              const points = await loyaltyStep("calculate-points", async () => {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const earnedPoints = Math.floor(totalAmount * 10); // 10 points per dollar
                addTimeline("calculate-points", "success", `Earned ${earnedPoints} points`);
                return { earnedPoints, multiplier: 1.0 };
              });

              // Nested child: Update customer tier
              const tier = await loyaltyStep("update-tier", async () => {
                await new Promise((resolve) => setTimeout(resolve, 45));
                const newTier =
                  totalAmount > 500 ? "gold" : totalAmount > 100 ? "silver" : "bronze";
                addTimeline("update-tier", "success", `Tier: ${newTier}`);
                return { tier: newTier, upgraded: totalAmount > 500 };
              });

              addTimeline(
                "loyalty-update",
                "success",
                `${points.earnedPoints} points, tier: ${tier.tier}`,
              );
              return { points, tier };
            },
            { parallel: true },
          ),

          // Parent step 3: Partner Sync (with nested steps)
          ctx.step(
            "partner-sync",
            async ({ step: syncStep }) => {
              // Nested child: Sync with supplier
              const supplier = await syncStep("sync-supplier", async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                addTimeline("sync-supplier", "success", "Supplier inventory updated");
                return { synced: true, supplierId: "SUP-001" };
              });

              // Nested child: Sync with warehouse
              const warehouse = await syncStep("sync-warehouse", async () => {
                await new Promise((resolve) => setTimeout(resolve, 70));
                addTimeline("sync-warehouse", "success", "Warehouse notified for picking");
                return { synced: true, warehouseId: "WH-MAIN" };
              });

              addTimeline("partner-sync", "success", "All partners synced");
              return { supplier, warehouse };
            },
            { parallel: true },
          ),
        ]);

        return { analytics, loyalty, partnerSync };
      },
    );

    addTimeline(
      "post-order-processing",
      "success",
      `Analytics: done, Loyalty: ${loyalty.points.earnedPoints}pts, Partners: ${analytics && partnerSync ? "synced" : "pending"}`,
    );

    return {
      orderId,
      status: "completed" as const,
      transactionId: payment.transactionId,
      shipmentId: fulfillment.shipment.shipmentId,
      timeline,
    };
  },
});

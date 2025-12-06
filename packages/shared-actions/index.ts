import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'
import { defineAction, NonRetriableError } from 'duron/index'
import * as z from 'zod'

export const variables = {
  sendEmail: async (args: { email: string; subject: string; body: string; timeout: number }, signal: AbortSignal) => {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, args.timeout)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })

    return {
      success: true,
    }
  },
  generateText: async (args: { prompt: string; model: string; temperature: number }, signal: AbortSignal) => {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new NonRetriableError('OPENAI_API_KEY environment variable is not set')
    }

    const result = await generateText({
      model: openai(args.model),
      prompt: args.prompt,
      temperature: args.temperature,
      abortSignal: signal,
    })

    return {
      text: result.text,
      usage: result.usage,
    }
  },
  getWeather: async (args: { city: string }, signal: AbortSignal) => {
    // Using Open-Meteo API (free, no API key required)
    const controller = new AbortController()
    signal.addEventListener('abort', () => controller.abort())

    // First, geocode the city name to get coordinates
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.city)}&count=1&language=en&format=json`
    const geocodeResponse = await fetch(geocodeUrl, {
      signal: controller.signal,
    })

    if (!geocodeResponse.ok) {
      throw new NonRetriableError(`Geocoding API error: ${geocodeResponse.status} ${geocodeResponse.statusText}`)
    }

    const geocodeData = (await geocodeResponse.json()) as {
      results?: Array<{
        latitude: number
        longitude: number
        name: string
        country_code: string
      }>
    }

    if (!geocodeData.results || geocodeData.results.length === 0) {
      throw new NonRetriableError(`City "${args.city}" not found`)
    }

    const firstResult = geocodeData.results[0]
    if (!firstResult) {
      throw new NonRetriableError(`City "${args.city}" not found`)
    }

    const { latitude, longitude, name, country_code } = firstResult

    // Then, fetch current weather data using coordinates
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,pressure_msl,weather_code,wind_speed_10m,visibility&timezone=auto`
    const weatherResponse = await fetch(weatherUrl, {
      signal: controller.signal,
    })

    if (!weatherResponse.ok) {
      throw new NonRetriableError(`Weather API error: ${weatherResponse.status} ${weatherResponse.statusText}`)
    }

    const weatherData = (await weatherResponse.json()) as {
      current: {
        temperature_2m: number
        apparent_temperature: number
        relative_humidity_2m: number
        pressure_msl: number
        weather_code: number
        wind_speed_10m: number
        visibility: number | null
      }
    }
    const current = weatherData.current

    // Map weather codes to descriptions (simplified)
    const weatherDescriptions: Record<number, string> = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      56: 'Light freezing drizzle',
      57: 'Dense freezing drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      71: 'Slight snow fall',
      73: 'Moderate snow fall',
      75: 'Heavy snow fall',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail',
    }

    return {
      city: name,
      country: country_code,
      temperature: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      pressure: current.pressure_msl,
      description: weatherDescriptions[current.weather_code] || 'Unknown',
      windSpeed: current.wind_speed_10m,
      visibility: current.visibility ? current.visibility / 1000 : null, // Convert to km
    }
  },
}

export const sendEmail = defineAction<typeof variables>()({
  name: 'sendEmail',
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
    const { email, subject, body } = ctx.input

    const { success } = await ctx.step(
      `send email to ${email}`,
      async ({ signal }) => {
        return ctx.var.sendEmail({ email, subject, body, timeout: ctx.input.timeout }, signal)
      },
      {
        expire: 6_000,
      },
    )

    return {
      success,
    }
  },
})

/**
 * It requires an OpenAI API key to be set in the environment variables: OPENAI_API_KEY.
 */
export const openaiChat = defineAction<typeof variables>()({
  name: 'openaiChat',
  input: z.object({
    prompt: z.string().min(1).describe('The prompt to send to OpenAI'),
    model: z.string().default('gpt-4o-mini').describe('The model to use (e.g., gpt-4o-mini, gpt-4o)'),
    temperature: z.number().min(0).max(1).default(1).describe('Temperature for text generation (0-1)'),
  }),
  output: z.object({
    text: z.string().describe('The generated text response'),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        totalTokens: z.number().optional(),
      })
      .describe('Token usage information'),
  }),
  handler: async (ctx) => {
    const { prompt, model, temperature } = ctx.input

    const result = await ctx.step(
      `generate text model=${model} temp=${temperature}`,
      async ({ signal }) => {
        return ctx.var.generateText({ prompt, model, temperature }, signal)
      },
      {
        expire: 60_000, // 60 seconds for AI generation
      },
    )

    return {
      text: result.text,
      usage: result.usage,
    }
  },
})

export const getWeather = defineAction<typeof variables>()({
  name: 'getWeather',
  input: z.object({
    city: z.string().min(1).describe('The city name to get weather for'),
  }),
  output: z.object({
    niceMessage: z.string().describe('A nice message for the weather'),
    info: z.object({
      city: z.string().describe('City name'),
      country: z.string().describe('Country code'),
      temperature: z.number().describe('Temperature in Celsius'),
      feelsLike: z.number().describe('Feels like temperature in Celsius'),
      humidity: z.number().describe('Humidity percentage'),
      pressure: z.number().describe('Atmospheric pressure in hPa'),
    }),
  }),
  handler: async (ctx) => {
    const { city } = ctx.input

    const weather = await ctx.step(
      `get weather for ${city}`,
      async ({ signal }) => {
        return ctx.var.getWeather({ city }, signal)
      },
      {
        expire: 10_000, // 10 seconds for weather API
      },
    )

    const niceMessage = await ctx.step(
      `generate nice message`,
      async ({ signal }) => {
        return ctx.var.generateText(
          {
            prompt: `Generate a nice message for the weather in ${city} based on the following weather data: ${JSON.stringify(weather)}`,
            model: 'gpt-4o-mini',
            temperature: 1,
          },
          signal,
        )
      },
      {
        expire: 60_000, // 60 seconds for AI generation
      },
    )

    return {
      niceMessage: niceMessage.text,
      info: weather,
    }
  },
})

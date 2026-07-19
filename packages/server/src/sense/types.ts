import { z } from 'zod';

/**
 * Zod schemas for the undocumented Sense cloud API. Everything uses
 * .passthrough()/.catch() defensively: we validate only the fields we use and
 * tolerate drift in the rest.
 */

export const senseAuthResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    user_id: z.number(),
    account_id: z.number().optional(),
    monitors: z
      .array(
        z
          .object({
            id: z.number(),
            time_zone: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type SenseAuthResponse = z.infer<typeof senseAuthResponseSchema>;

export const senseMfaChallengeSchema = z
  .object({
    status: z.string().optional(),
    error_reason: z.string().optional(),
    mfa_token: z.string(),
  })
  .passthrough();

export const senseDeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string().nullish(),
    type: z.string().nullish(),
    tags: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();
export type SenseDevice = z.infer<typeof senseDeviceSchema>;

/** trends response: totals plus per-device consumption for the period. */
export const senseTrendsSchema = z
  .object({
    steps: z.number().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    consumption: z
      .object({
        total: z.number().default(0), // kWh for the period
        totals: z.array(z.number().nullable()).optional(), // kWh per step
        devices: z
          .array(
            z
              .object({
                id: z.string(),
                name: z.string().optional(),
                icon: z.string().nullish(),
                total_kwh: z.number().nullish(),
                avg_w: z.number().nullish(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .optional(),
    production: z
      .object({
        total: z.number().default(0), // solar kWh for the period
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SenseTrends = z.infer<typeof senseTrendsSchema>;

export const senseTimelineItemSchema = z
  .object({
    time: z.string(), // ISO timestamp
    type: z.string(), // e.g. 'DeviceOn' | 'DeviceOff' | others we ignore
    device_id: z.string().optional(),
    body: z.string().optional(),
    device_state: z.string().optional(),
    user_device_type: z.string().optional(),
  })
  .passthrough();
export type SenseTimelineItem = z.infer<typeof senseTimelineItemSchema>;

export const senseTimelineSchema = z
  .object({
    items: z.array(senseTimelineItemSchema).default([]),
    sticky_items: z.array(senseTimelineItemSchema).optional(),
  })
  .passthrough();
export type SenseTimeline = z.infer<typeof senseTimelineSchema>;

/** One realtime_update payload from the websocket feed. */
export const senseRealtimePayloadSchema = z
  .object({
    w: z.number(),
    solar_w: z.number().optional(),
    hz: z.number().optional(),
    voltage: z.array(z.number()).optional(),
    devices: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            icon: z.string().nullish(),
            w: z.number(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
export type SenseRealtimePayload = z.infer<typeof senseRealtimePayloadSchema>;

export const senseWsMessageSchema = z
  .object({
    type: z.string(),
    payload: z.unknown().optional(),
  })
  .passthrough();

export type TrendScale = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

/** Tokens persisted in the kv store across restarts. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  userId: number;
  accountId: number | null;
  monitorId: number;
  monitorTz: string | null;
}

import { z } from 'zod';

const envSchema = z.object({
  SENSE_EMAIL: z.string().default(''),
  SENSE_PASSWORD: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default('./data'),
  TZ: z.string().default('UTC'),
  CURRENCY: z.string().default('USD'),
  ELECTRICITY_RATE_CENTS_PER_KWH: z.coerce.number().nonnegative().default(15),
  SENSE_MOCK: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
  REALTIME_MODE: z.enum(['persistent', 'duty-cycle']).default('persistent'),
  MQTT_URL: z.string().default(''),
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  LAT: z.string().default(''),
  LON: z.string().default(''),
  BACKUP_DIR: z.string().default(''),
});

export type Config = {
  senseEmail: string;
  sensePassword: string;
  port: number;
  dataDir: string;
  tz: string;
  currency: string;
  defaultRateCentsPerKwh: number;
  mock: boolean;
  realtimeMode: 'persistent' | 'duty-cycle';
  mqttUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  lat: string;
  lon: string;
  backupDir: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  if (!e.SENSE_MOCK && (!e.SENSE_EMAIL || !e.SENSE_PASSWORD)) {
    throw new Error(
      'SENSE_EMAIL and SENSE_PASSWORD are required (or set SENSE_MOCK=1 for fixture replay mode)',
    );
  }
  return {
    senseEmail: e.SENSE_EMAIL,
    sensePassword: e.SENSE_PASSWORD,
    port: e.PORT,
    dataDir: e.DATA_DIR,
    tz: e.TZ,
    currency: e.CURRENCY,
    defaultRateCentsPerKwh: e.ELECTRICITY_RATE_CENTS_PER_KWH,
    mock: e.SENSE_MOCK,
    realtimeMode: e.REALTIME_MODE,
    mqttUrl: e.MQTT_URL,
    mqttUsername: e.MQTT_USERNAME,
    mqttPassword: e.MQTT_PASSWORD,
    lat: e.LAT,
    lon: e.LON,
    backupDir: e.BACKUP_DIR,
  };
}

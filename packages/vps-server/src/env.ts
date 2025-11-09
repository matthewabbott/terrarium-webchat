import { z } from 'zod';

const envSchema = z.object({
  CHAT_PASSWORD: z.string().min(1, 'CHAT_PASSWORD is required'),
  SERVICE_TOKEN: z.string().min(1, 'SERVICE_TOKEN is required'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),
  CHAT_TTL_HOURS: z.coerce.number().default(6)
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid env: ${parsed.error.message}`);
  }
  return parsed.data;
}

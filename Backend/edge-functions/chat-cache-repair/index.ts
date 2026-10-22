import { cacheRepairHandler } from './repair.ts';
import { maintenanceConfig } from './runtime-config.ts';

Deno.serve(cacheRepairHandler({
  projectUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  ...maintenanceConfig,
}));

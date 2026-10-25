import {avatarMaintenanceHandler} from './handler.ts';
import {maintenanceConfig} from './runtime-config.ts';
Deno.serve(avatarMaintenanceHandler({
  projectUrl:Deno.env.get('SUPABASE_URL') || '',
  serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  ...maintenanceConfig,
}));

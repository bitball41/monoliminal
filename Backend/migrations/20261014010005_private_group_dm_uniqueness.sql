BEGIN;

-- One ordinary DM per participant set; groups may share members and start or end
-- with the same singleton/empty membership. Preserve the existing Luna exception.
DROP INDEX IF EXISTS public.dms_non_luna_participants_unique_idx;
CREATE UNIQUE INDEX dms_non_luna_participants_unique_idx
ON public.dms(participants)
WHERE NOT is_group AND NOT ('Luna'=ANY(participants));

COMMIT;

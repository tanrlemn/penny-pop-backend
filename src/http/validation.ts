import { z } from 'zod';

export const chatMessageRequestSchema = z.object({
  householdId: z.string().uuid(),
  messageText: z.string().min(1),
});

export const applyActionsRequestSchema = z.object({
  householdId: z.string().uuid(),
  actionIds: z.array(z.string().uuid()).min(1),
});

import { z } from 'zod';

const confidenceSchema = z.number().min(0).max(1);

const budgetTransferPayloadSchema = z
  .object({
    kind: z.literal('budget_transfer'),
    amount_in_cents: z.number().int().positive(),
    from_pod_id: z.string().min(1),
    from_pod_name: z.string().min(1),
    to_pod_id: z.string().min(1),
    to_pod_name: z.string().min(1),
  })
  .strict();

const budgetRepairRestoreDonorPayloadSchema = z
  .object({
    kind: z.literal('budget_repair_restore_donor'),
    amount_in_cents: z.number().int().positive(),
    donor_pod_id: z.string().min(1),
    donor_pod_name: z.string().min(1),
    funding_pod_id: z.string().min(1),
    funding_pod_name: z.string().min(1),
    option_label: z.string().min(1).optional(),
  })
  .strict();

const proposedActionDraftSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('budget_transfer'),
      payload: budgetTransferPayloadSchema,
      confidence: confidenceSchema.optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('budget_repair_restore_donor'),
      payload: budgetRepairRestoreDonorPayloadSchema,
      confidence: confidenceSchema.optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
]);

const entitiesSchema = z
  .object({
    fromCandidate: z.string().min(1).nullable().optional(),
    toCandidate: z.string().min(1).nullable().optional(),
    fundingCandidate: z.string().min(1).nullable().optional(),
  })
  .strict();

export const aiActionsOutputSchema = z
  .object({
    assistantText: z.string().min(1),
    proposedActionDrafts: z.array(proposedActionDraftSchema).max(3),
    entities: entitiesSchema.optional(),
  })
  .strict();

export type AiActionsOutput = z.infer<typeof aiActionsOutputSchema>;


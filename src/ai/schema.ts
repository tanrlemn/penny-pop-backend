import { z } from 'zod';

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

const budgetAdjustPayloadSchema = z
  .object({
    kind: z.literal('budget_adjust'),
    delta_in_cents: z.number().int(),
    pod_id: z.string().min(1),
    pod_name: z.string().min(1),
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
    })
    .strict(),
  z
    .object({
      type: z.literal('budget_adjust'),
      payload: budgetAdjustPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('budget_repair_restore_donor'),
      payload: budgetRepairRestoreDonorPayloadSchema,
    })
    .strict(),
]);

const parsedEntitiesHintsSchema = z
  .object({
    fromCandidate: z.string().min(1).nullable().optional(),
    toCandidate: z.string().min(1).nullable().optional(),
    fundingCandidate: z.string().min(1).nullable().optional(),
    candidates: z.array(z.string().min(1)),
  })
  .strict();

export const aiProposeResponseSchema = z
  .object({
    intent: z.enum(['observed_transfer', 'question_advice', 'request_budget_change']),
    assistantText: z.string().min(1),
    proposedActionDrafts: z.array(proposedActionDraftSchema).max(3),
    entities: parsedEntitiesHintsSchema.optional(),
  })
  .strict();

export type AiProposeResponse = z.infer<typeof aiProposeResponseSchema>;

export const aiProposeResponseToolSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: {
      type: 'string',
      enum: ['observed_transfer', 'question_advice', 'request_budget_change'],
    },
    assistantText: { type: 'string', minLength: 1 },
    proposedActionDrafts: {
      type: 'array',
      maxItems: 3,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { const: 'budget_transfer', description: 'Draft discriminator; must match payload.kind.' },
              payload: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { const: 'budget_transfer', description: 'Payload discriminator; must match draft type.' },
                  amount_in_cents: { type: 'integer', minimum: 1 },
                  from_pod_id: { type: 'string', minLength: 1 },
                  from_pod_name: { type: 'string', minLength: 1 },
                  to_pod_id: { type: 'string', minLength: 1 },
                  to_pod_name: { type: 'string', minLength: 1 },
                },
                required: [
                  'kind',
                  'amount_in_cents',
                  'from_pod_id',
                  'from_pod_name',
                  'to_pod_id',
                  'to_pod_name',
                ],
              },
            },
            required: ['type', 'payload'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { const: 'budget_adjust', description: 'Draft discriminator; must match payload.kind.' },
              payload: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { const: 'budget_adjust', description: 'Payload discriminator; must match draft type.' },
                  delta_in_cents: { type: 'integer' },
                  pod_id: { type: 'string', minLength: 1 },
                  pod_name: { type: 'string', minLength: 1 },
                },
                required: ['kind', 'delta_in_cents', 'pod_id', 'pod_name'],
              },
            },
            required: ['type', 'payload'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                const: 'budget_repair_restore_donor',
                description: 'Draft discriminator; must match payload.kind.',
              },
              payload: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: {
                    const: 'budget_repair_restore_donor',
                    description: 'Payload discriminator; must match draft type.',
                  },
                  amount_in_cents: { type: 'integer', minimum: 1 },
                  donor_pod_id: { type: 'string', minLength: 1 },
                  donor_pod_name: { type: 'string', minLength: 1 },
                  funding_pod_id: { type: 'string', minLength: 1 },
                  funding_pod_name: { type: 'string', minLength: 1 },
                  option_label: { type: 'string', minLength: 1 },
                },
                required: [
                  'kind',
                  'amount_in_cents',
                  'donor_pod_id',
                  'donor_pod_name',
                  'funding_pod_id',
                  'funding_pod_name',
                ],
              },
            },
            required: ['type', 'payload'],
          },
        ],
      },
    },
    entities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromCandidate: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        toCandidate: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        fundingCandidate: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        candidates: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      required: ['candidates'],
    },
  },
  required: ['intent', 'assistantText', 'proposedActionDrafts'],
};


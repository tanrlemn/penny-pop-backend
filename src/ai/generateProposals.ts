import { interpretMessage } from '../chat/interpretMessage';
import type { PodSettingsCategory, Uuid } from '../types/supabase';

type PodSnapshot = {
  id: Uuid;
  name: string;
  budgeted_amount_in_cents?: number | null;
  category?: PodSettingsCategory | null;
};

type GenerateProposalsArgs = {
  messageText: string;
  pods: PodSnapshot[];
};

type GenerateProposalsResult = ReturnType<typeof interpretMessage>;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('AI proposal timeout')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function generateProposals(
  args: GenerateProposalsArgs,
): Promise<GenerateProposalsResult> {
  try {
    return await withTimeout(Promise.resolve(interpretMessage(args)), 10_000);
  } catch {
    return interpretMessage(args);
  }
}

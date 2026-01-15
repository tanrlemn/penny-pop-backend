import { listActivePodsWithSettingsForUser } from '../repos/podsRepo';

async function main(): Promise<void> {
  const userId = process.env.USER_ID ?? process.argv[2];

  if (!userId) {
    console.log('Usage: USER_ID=<uuid> node dist/scripts/testSupabasePods.js');
    console.log('  or:  node dist/scripts/testSupabasePods.js <uuid>');
    process.exitCode = 1;
    return;
  }

  const hasSupabaseEnv =
    !!process.env.SUPABASE_URL &&
    (!!process.env.SUPABASE_SECRET_KEY || !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!hasSupabaseEnv) {
    console.log(
      'SUPABASE_URL and/or SUPABASE_SECRET_KEY not set; skipping live query.',
    );
    console.log('If set, this script will fetch active pods+settings for USER_ID.');
    return;
  }

  const pods = await listActivePodsWithSettingsForUser(userId);

  console.log(
    JSON.stringify(
      {
        userId,
        podCount: pods.length,
        pods,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


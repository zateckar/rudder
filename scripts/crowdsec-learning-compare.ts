import { compareLearningEvidence } from '../src/lib/crowdsec-learning-evidence';

if (import.meta.main) {
  const [observations, ...sessions] = Bun.argv.slice(2);
  if (observations === '--help' || !observations || !sessions.length) {
    console.log('Usage: bun scripts/crowdsec-learning-compare.ts observations.json session.json [session.json ...]');
    process.exit(observations === '--help' ? 0 : 2);
  }
  try {
    const report = compareLearningEvidence(
      await Promise.all(sessions.map((path) => Bun.file(path).json())),
      await Bun.file(observations).json(),
    );
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.eligibleForReview ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not process learning evidence.');
    process.exitCode = 2;
  }
}

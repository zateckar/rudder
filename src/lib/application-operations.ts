export const operationStages = {
  preparing: 'Preparing',
  creating: 'Pulling images and creating containers',
  starting: 'Starting containers',
  verifying: 'Verifying container health',
  routing: 'Switching traffic',
  acknowledging: 'Waiting for worker routing acknowledgement',
  draining: 'Draining the previous generation',
  restoring: 'Restoring the previous routing',
  cleaning: 'Cleaning up the candidate generation',
} as const;

export type OperationStage = keyof typeof operationStages;
export type ReportOperationProgress = (stage: OperationStage, deploymentId?: string) => void;

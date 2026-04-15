/** Types for the monitor action. */

export type MonitorProfile = "default" | "ci";

/** State persisted between main and post steps via core.saveState. */
export interface OtelState {
  pid: number;
  configPath: string;
  outputPath: string;
  logPath: string;
  metricsDir: string;
  startTime: number;
  runId: string;
  dataBranch: string;
  profile?: MonitorProfile;
  /**
   * Runner worker PID (our process's parent). Used in post-processing to
   * filter process metrics to only descendants of the runner — keeps
   * benchmark-spawned processes, drops system daemons.
   */
  runnerPpid?: number;
}

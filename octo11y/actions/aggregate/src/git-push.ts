export type PushFailure =
  | { kind: "non-fast-forward" }
  | { kind: "other" };

export function classifyPushFailure(stderr: string): PushFailure {
  if (
    stderr.includes("failed to push some refs")
    && (
      stderr.includes("non-fast-forward")
      || stderr.includes("fetch first")
      || stderr.includes("Updates were rejected because the remote contains work that you do not have locally")
    )
  ) {
    return { kind: "non-fast-forward" };
  }

  return { kind: "other" };
}

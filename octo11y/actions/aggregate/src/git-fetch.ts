export type FetchFailure =
  | { kind: "branch-missing" }
  | { kind: "checked-out"; message: string }
  | { kind: "other" };

export function classifyFetchFailure(dataBranch: string, stderr: string): FetchFailure {
  if (
    stderr.includes("refusing to fetch into branch")
    && stderr.includes("checked out")
  ) {
    return {
      kind: "checked-out",
      message:
        `Cannot aggregate: '${dataBranch}' is already checked out at the current working directory. `
        + `Remove the 'ref: ${dataBranch}' input from your actions/checkout step — `
        + "the aggregate action fetches the data branch into its own worktree.",
    };
  }
  if (stderr.includes("couldn't find remote ref")) {
    return { kind: "branch-missing" };
  }
  return { kind: "other" };
}

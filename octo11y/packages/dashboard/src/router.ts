import { useState, useEffect, useCallback } from "preact/hooks";

export type Route =
  | { page: "guide" }
  | { page: "benchstory" }
  | { page: "custom" }
  | { page: "docs" }
  | { page: "benchmarks" }
  | { page: "benchmark"; name: string }
  | { page: "metric"; name: string }
  | { page: "run"; id: string };

function parseHash(): Route {
  const h = location.hash.slice(1);
  if (!h || h === "guide") return { page: "guide" };
  if (h === "benchstory") return { page: "benchstory" };
  if (h === "custom") return { page: "custom" };
  if (h === "docs") return { page: "docs" };
  if (h === "benchmarks") return { page: "benchmarks" };
  if (h.startsWith("benchmark/")) return { page: "benchmark", name: decodeURIComponent(h.slice(10)) };
  if (h.startsWith("metric/")) return { page: "metric", name: decodeURIComponent(h.slice(7)) };
  if (h.startsWith("run/")) return { page: "run", id: decodeURIComponent(h.slice(4)) };
  return { page: "guide" };
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((r: Route) => {
    let h = "";
    if (r.page === "guide") h = "";
    else if (r.page === "benchstory") h = "benchstory";
    else if (r.page === "custom") h = "custom";
    else if (r.page === "docs") h = "docs";
    else if (r.page === "benchmarks") h = "benchmarks";
    else if (r.page === "benchmark") h = `benchmark/${encodeURIComponent(r.name)}`;
    else if (r.page === "metric") h = `metric/${encodeURIComponent(r.name)}`;
    else if (r.page === "run") h = `run/${encodeURIComponent(r.id)}`;
    location.hash = h;
    setRoute(r);
    window.scrollTo(0, 0);
  }, []);
  return [route, go];
}

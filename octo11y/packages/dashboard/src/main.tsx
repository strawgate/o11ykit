import { render } from "preact";
import "@benchkit/chart/css";
import { useRoute } from "./router";
import { useBenchData } from "./hooks/use-bench-data";
import { Shell } from "./components/ui";
import { GuidePage } from "./pages/GuidePage";
import { BenchmarkStoryPage } from "./pages/BenchmarkStoryPage";
import { CustomPage } from "./pages/CustomPage";
import { DocsPage } from "./pages/DocsPage";
import { BenchmarksPage } from "./pages/BenchmarksPage";
import { BenchmarkDetailPage } from "./pages/BenchmarkDetailPage";
import { MetricDetailPage } from "./pages/MetricDetailPage";
import { RunDetailPage } from "./pages/RunDetailPage";

function App() {
  const [route, go] = useRoute();
  const data = useBenchData();

  return (
    <Shell route={route} go={go}>
      {route.page === "guide" && <GuidePage go={go} />}
      {route.page === "benchstory" && <BenchmarkStoryPage go={go} />}
      {route.page === "custom" && <CustomPage go={go} />}
      {route.page === "docs" && <DocsPage go={go} />}
      {route.page === "benchmarks" && <BenchmarksPage data={data} go={go} />}
      {route.page === "benchmark" && <BenchmarkDetailPage name={route.name} data={data} go={go} />}
      {route.page === "metric" && <MetricDetailPage name={route.name} data={data} go={go} />}
      {route.page === "run" && <RunDetailPage id={route.id} go={go} />}
    </Shell>
  );
}

render(<App />, document.getElementById("app")!);

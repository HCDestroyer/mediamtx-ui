import { lazy, Suspense } from "react";
import { Spinner, ToastProvider } from "@heroui/react";
import { AppShell } from "./components/AppShell";
import { useConnectionManager } from "./hooks/useActiveConnection";
import { useRoute } from "./router";
const ChannelsPage = lazy(() => import("./pages/ChannelsPage"));
const ChannelDetailPage = lazy(() => import("./pages/ChannelDetailPage"));

// Secondary screens are split out to keep the initial bundle small.
const ServersPage = lazy(() => import("./pages/ServersPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

function Page() {
  const route = useRoute();
  switch (route.name) {
    case "channels":
      return <ChannelsPage />;
    case "channel":
      return <ChannelDetailPage name={route.channel} />;
    case "connections":
      return <ConnectionsPage />;
    case "servers":
      return <ServersPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <NotFoundPage />;
  }
}

export default function App() {
  useConnectionManager();
  return (
    <>
      <AppShell>
        <Suspense
          fallback={
            <div className="grid place-items-center py-24">
              <Spinner />
            </div>
          }
        >
          <Page />
        </Suspense>
      </AppShell>
      <ToastProvider placement="bottom end" />
    </>
  );
}

import { lazy, Suspense, type ReactNode } from "react";
import { Spinner, ToastProvider } from "@heroui/react";
import { AppShell } from "./components/AppShell";
import { useAutoLock } from "./hooks/useAutoLock";
import { useConnectionManager } from "./hooks/useActiveConnection";
import { useRoute } from "./router";
import { useAuth } from "./store/auth";

// Every screen is split out to keep the initial bundle small.
const ChannelsPage = lazy(() => import("./pages/ChannelsPage"));
const ChannelDetailPage = lazy(() => import("./pages/ChannelDetailPage"));
const ServersPage = lazy(() => import("./pages/ServersPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ConnectionsPage = lazy(() => import("./pages/ConnectionsPage"));
const ServicesPage = lazy(() => import("./pages/ServicesPage"));
const ConfigPage = lazy(() => import("./pages/ConfigPage"));
const BinariesPage = lazy(() => import("./pages/BinariesPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const SetupScreen = lazy(() => import("./components/auth/SetupScreen"));
const LockScreen = lazy(() => import("./components/auth/LockScreen"));

const Loading = () => (
  <div className="grid place-items-center py-24">
    <Spinner />
  </div>
);

function Page() {
  const route = useRoute();
  switch (route.name) {
    case "channels":
      return <ChannelsPage />;
    case "channel":
      return <ChannelDetailPage name={route.channel} />;
    case "connections":
      return <ConnectionsPage />;
    case "services":
      return <ServicesPage />;
    case "config":
      return <ConfigPage />;
    case "binaries":
      return <BinariesPage />;
    case "servers":
      return <ServersPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return <NotFoundPage />;
  }
}

/** Nothing behind the gate runs (no connections, no polling) until the panel is open. */
function Gate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  if (status === "setup") return <Suspense fallback={<Loading />}><SetupScreen /></Suspense>;
  if (status === "locked") return <Suspense fallback={<Loading />}><LockScreen /></Suspense>;
  return <>{children}</>;
}

function Panel() {
  useConnectionManager();
  useAutoLock();
  return (
    <AppShell>
      <Suspense fallback={<Loading />}>
        <Page />
      </Suspense>
    </AppShell>
  );
}

export default function App() {
  return (
    <>
      <Gate>
        <Panel />
      </Gate>
      <ToastProvider placement="bottom end" />
    </>
  );
}

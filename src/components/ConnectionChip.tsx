import { Chip, Spinner } from "@heroui/react";
import { Wifi, WifiOff } from "lucide-react";
import { fmt, t } from "../i18n/es";
import { useActiveServer } from "../hooks/useActiveConnection";

/** Header chip with the active network and its latency. */
export function ConnectionChip() {
  const { server, connection } = useActiveServer();
  if (!server) {
    return (
      <Chip size="sm" variant="soft">
        {t.connection.none}
      </Chip>
    );
  }
  switch (connection.status) {
    case "online": {
      const network = connection.active ? t.network[connection.active.endpoint.type] : "";
      return (
        <Chip size="sm" color="success" variant="soft">
          <Wifi size={14} aria-hidden />
          <span className="tabular">
            {fmt(t.connection.online, { network, ms: connection.active?.latencyMs ?? 0 })}
          </span>
        </Chip>
      );
    }
    case "auth-error":
      return (
        <Chip size="sm" color="warning" variant="soft">
          <WifiOff size={14} aria-hidden />
          {t.connection.authError}
        </Chip>
      );
    case "offline":
      return (
        <Chip size="sm" color="danger" variant="soft">
          <WifiOff size={14} aria-hidden />
          {t.connection.offline}
        </Chip>
      );
    default:
      return (
        <Chip size="sm" variant="soft">
          <Spinner size="sm" />
          {t.connection.resolving}
        </Chip>
      );
  }
}

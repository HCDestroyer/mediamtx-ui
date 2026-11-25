import { Button, Card, Chip, EmptyState } from "@heroui/react";
import { Plus, Radio } from "lucide-react";
import { useActiveServer } from "../hooks/useActiveConnection";
import { t } from "../i18n/es";

export default function ChannelsPage() {
  const { server, connection } = useActiveServer();

  if (!server) {
    return (
      <EmptyState className="flex flex-col items-center gap-3 py-20 text-center">
        <Radio size={36} aria-hidden className="text-[var(--muted)]" />
        <h1 className="text-xl font-bold">{t.channels.noServerTitle}</h1>
        <p className="max-w-sm text-sm text-[var(--muted)]">{t.channels.noServerBody}</p>
        <Button variant="primary" onPress={() => (window.location.hash = "#/servers")}>
          <Plus size={16} aria-hidden />
          {t.servers.add}
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold tracking-tight">{t.channels.title}</h1>
      <Card>
        <Card.Header className="flex flex-row items-center gap-2">
          <span className="size-3 rounded-full" style={{ background: server.color }} aria-hidden />
          <Card.Title>{t.channels.connectedTo} {server.name}</Card.Title>
        </Card.Header>
        <Card.Content className="flex flex-col gap-3">
          {connection.status === "online" && connection.active ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <dt className="text-[var(--muted)]">{t.channels.endpoint}</dt>
              <dd className="text-right">
                <Chip size="sm" color="success" variant="soft">
                  {t.network[connection.active.endpoint.type]}
                </Chip>{" "}
                <code className="text-xs">{connection.active.endpoint.apiUrl}</code>
              </dd>
              <dt className="text-[var(--muted)]">{t.channels.latency}</dt>
              <dd className="tabular text-right">{connection.active.latencyMs} ms</dd>
            </dl>
          ) : null}
          <p className="text-sm text-[var(--muted)]">{t.channels.comingBody}</p>
        </Card.Content>
      </Card>
    </div>
  );
}

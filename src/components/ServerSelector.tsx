import { Dropdown } from "@heroui/react";
import { ChevronDown, Plus } from "lucide-react";
import { t } from "../i18n/es";
import { selectActiveServer, useServers } from "../store/servers";
import { useConnection, connectionOf } from "../store/connection";

const ADD_KEY = "__add__";

interface ServerSelectorProps {
  className?: string;
}

/** Switches the active server; also the entry point to add one. */
export function ServerSelector({ className = "" }: ServerSelectorProps) {
  const servers = useServers((s) => s.servers);
  const active = useServers(selectActiveServer);
  const setActive = useServers((s) => s.setActiveServer);
  const connection = useConnection((s) => connectionOf(s.byServer, active?.id));
  const subtitle =
    connection.status === "online" && connection.active
      ? t.network[connection.active.endpoint.type]
      : t.serverSelector.label;

  return (
    <Dropdown>
      <Dropdown.Trigger
        className={`flex w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${className}`}
      >
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ background: active?.color ?? "var(--muted)" }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight">
            {active?.name ?? t.serverSelector.empty}
          </span>
          <span className="block truncate text-xs text-[var(--muted)]">{subtitle}</span>
        </span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-[var(--muted)]" />
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu
          aria-label={t.serverSelector.label}
          onAction={(key) => {
            if (key === ADD_KEY) window.location.hash = "#/servers";
            else setActive(String(key));
          }}
        >
          {servers.map((server) => (
            <Dropdown.Item key={server.id} id={server.id} textValue={server.name}>
              <span className="size-2.5 rounded-full" style={{ background: server.color }} aria-hidden />
              {server.name}
            </Dropdown.Item>
          ))}
          <Dropdown.Item id={ADD_KEY} textValue={t.serverSelector.add}>
            <Plus size={14} aria-hidden />
            {t.serverSelector.add}
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

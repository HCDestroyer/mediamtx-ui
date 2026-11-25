import { Dropdown, toast } from "@heroui/react";
import { buttonVariants } from "@heroui/styles";
import { ChevronDown, Copy } from "lucide-react";
import { copyText } from "../core/clipboard";
import { buildReadUrls, hostOf } from "../core/mediamtx/urls";
import { t } from "../i18n/es";
import { useChannels } from "../store/channels";
import { useActiveServer } from "../hooks/useActiveConnection";

interface CopyUrlMenuProps {
  channel: string;
  /** `primary` is the call to action of the detail screen; `ghost` is for table rows. */
  variant?: "primary" | "ghost";
  size?: "sm" | "md";
  iconOnly?: boolean;
}

/** Menu with the read URLs of a channel (RTSP, RTMP, SRT, HLS, WebRTC); picking one copies it. */
export function CopyUrlMenu({ channel, variant = "primary", size = "md", iconOnly = false }: CopyUrlMenuProps) {
  const { connection } = useActiveServer();
  const ports = useChannels((s) => s.ports);
  const host = connection.active ? hostOf(connection.active.endpoint.apiUrl) : "";
  const entries = ports && host ? buildReadUrls(host, channel, ports) : [];

  const copy = async (key: string) => {
    const entry = entries.find((e) => e.protocol === key);
    if (!entry) return;
    if (await copyText(entry.url)) toast.success(t.detail.copied, { description: entry.url });
    else toast.danger(t.detail.copyFailed);
  };

  return (
    <Dropdown>
      <Dropdown.Trigger
        isDisabled={entries.length === 0}
        aria-label={iconOnly ? t.detail.copyUrl : undefined}
        className={`${buttonVariants({ variant, size, isIconOnly: iconOnly })} inline-flex items-center justify-center gap-2 whitespace-nowrap`}
      >
        <Copy size={size === "sm" ? 14 : 16} aria-hidden />
        {iconOnly ? null : t.detail.copyUrl}
        {iconOnly ? null : <ChevronDown size={14} aria-hidden />}
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu aria-label={t.detail.copyUrl} onAction={(key) => void copy(String(key))}>
          {entries.map((entry) => (
            <Dropdown.Item key={entry.protocol} id={entry.protocol} textValue={entry.label}>
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{entry.label}</span>
                <span className="max-w-[18rem] truncate font-mono text-xs text-[var(--muted)]">{entry.url}</span>
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

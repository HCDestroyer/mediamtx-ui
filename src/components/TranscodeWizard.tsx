import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Label, ListBox, Select, toast, type UseOverlayStateReturn } from "@heroui/react";
import { Copy } from "lucide-react";
import { copyText } from "../core/clipboard";
import { getPathConf } from "../core/mediamtx/api";
import {
  applyPlan, DEFAULT_ENCODER, DEFAULT_RESOLUTION, planTranscode, RESOLUTIONS, type Encoder,
} from "../core/transcode";
import { apiErrorMessage, usePathApi } from "../hooks/usePathApi";
import { fmt, t } from "../i18n/es";
import { useChannels } from "../store/channels";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

interface TranscodeWizardProps {
  state: UseOverlayStateReturn;
  /** Channel preselected as the origin. */
  origin?: string;
}

export function TranscodeWizard({ state, origin }: TranscodeWizardProps) {
  return state.isOpen ? <WizardBody key={origin ?? ""} state={state} origin={origin} /> : null;
}

function WizardBody({ state, origin: initialOrigin }: TranscodeWizardProps) {
  const api = usePathApi();
  const channels = useChannels((s) => s.channels);
  const [origin, setOrigin] = useState(initialOrigin ?? "");
  const [height, setHeight] = useState<number>(DEFAULT_RESOLUTION.height);
  const [encoder, setEncoder] = useState<Encoder>(DEFAULT_ENCODER);
  const [current, setCurrent] = useState<{ hook: string; restart: boolean }>({ hook: "", restart: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const originChannel = channels.find((c) => c.name === origin);
  const resolution = RESOLUTIONS.find((r) => r.height === height) ?? DEFAULT_RESOLUTION;

  // The hook the origin already has decides whether the plan warns about replacing it.
  useEffect(() => {
    setCurrent({ hook: "", restart: false });
    if (!api.client || !origin || originChannel?.kind !== "configured") return;
    let cancelled = false;
    getPathConf(api.client, origin)
      .then((conf) => {
        if (cancelled) return;
        setCurrent({
          hook: String(conf[api.hook.command] ?? ""),
          restart: conf[api.hook.restart] === true,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, originChannel?.kind]);

  const plan = useMemo(
    () =>
      origin
        ? planTranscode({
            origin, resolution, encoder, rtspPort: api.rtspPort, hook: api.hook,
            originConfigured: originChannel?.kind === "configured",
            currentHook: current.hook, currentHookRestart: current.restart,
            destinationExists: channels.some((c) => c.name === `${origin}_${height}` && c.kind === "configured"),
          })
        : null,
    [origin, resolution, encoder, height, api.rtspPort, api.hook, originChannel?.kind, current, channels],
  );

  const run = async () => {
    if (!api.client || !plan || plan.errors.length > 0) return;
    setPending(true);
    setError(null);
    try {
      await applyPlan(api.client, plan.operations);
      api.wrote();
      toast.success(fmt(t.transcode.created, { name: plan.destination }));
      state.close();
    } catch (e) {
      setError(apiErrorMessage(e, t.transcode.failed));
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (plan && (await copyText(plan.command))) toast.success(t.transcode.commandCopied);
  };

  const select = (
    label: string, value: string, onChange: (key: string) => void, items: Array<{ id: string; label: string }>,
    placeholder?: string,
  ) => (
    <Select selectedKey={value || null} onSelectionChange={(key) => key && onChange(String(key))} aria-label={label} placeholder={placeholder}>
      <Label>{label}</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id} id={item.id} textValue={item.label}>{item.label}<ListBox.ItemIndicator /></ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );

  const footer = (
    <>
      <Button variant="secondary" onPress={copy} isDisabled={!plan}>
        <Copy size={16} aria-hidden />
        {t.transcode.copyCommand}
      </Button>
      <div className="flex-1" />
      <Button variant="tertiary" onPress={state.close}>{t.edit.cancel}</Button>
      <Button variant="primary" onPress={run} isPending={pending} isDisabled={!plan || plan.errors.length > 0 || !api.client}>
        {fmt(t.transcode.create, { height })}
      </Button>
    </>
  );

  return (
    <ResponsiveOverlay state={state} title={t.transcode.title} footer={footer} size="lg">
      <div className="flex flex-col gap-4">
        {select(t.transcode.origin, origin, setOrigin, channels.map((c) => ({ id: c.name, label: c.name })), t.transcode.originPlaceholder)}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {select(t.transcode.resolution, String(height), (k) => setHeight(Number(k)), RESOLUTIONS.map((r) => ({ id: String(r.height), label: `${r.height}p · ${r.kbps / 1000} Mbps` })))}
          {select(t.transcode.encoder, encoder, (k) => setEncoder(k as Encoder), [
            { id: "libx264", label: t.transcode.encoderCpu },
            { id: "h264_nvenc", label: t.transcode.encoderGpu },
          ])}
        </div>
        <p className="-mt-2 text-xs text-[var(--muted)]">
          {encoder === "libx264" ? t.transcode.encoderCpuHelp : t.transcode.encoderGpuHelp} {t.transcode.needsFfmpeg}
        </p>

        {plan ? (
          <>
            {plan.errors.map((code) => (
              <Alert key={code} status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{t.transcode.errors[code]}</Alert.Description></Alert.Content></Alert>
            ))}
            {plan.warnings.filter((w) => w !== "destination-exists").map((code) => (
              <Alert key={code} status="warning"><Alert.Indicator /><Alert.Content><Alert.Description>{t.transcode.warnings[code]}</Alert.Description></Alert.Content></Alert>
            ))}
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {plan.warnings.includes("destination-exists")
                ? <li>{fmt(t.transcode.willReuse, { name: plan.destination })}</li>
                : <li>{fmt(t.transcode.willCreate, { name: plan.destination })}</li>}
              <li>
                {plan.warnings.includes("origin-dynamic")
                  ? fmt(t.transcode.willConfigureOrigin, { name: origin })
                  : fmt(t.transcode.willSetHook, { name: origin })}
              </li>
            </ul>
            <div>
              <p className="mb-1 text-sm font-medium">{t.transcode.command}</p>
              <pre className="whitespace-pre-wrap break-all rounded-lg bg-[var(--surface-secondary)] p-3 text-xs leading-relaxed">{plan.command}</pre>
            </div>
          </>
        ) : null}

        {error ? (
          <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Title>{t.transcode.failed}</Alert.Title><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>
        ) : null}
      </div>
    </ResponsiveOverlay>
  );
}

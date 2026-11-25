import { useState, type FormEvent } from "react";
import {
  Button,
  FieldError,
  Form,
  Input,
  Label,
  TextField,
  type UseOverlayStateReturn,
} from "@heroui/react";
import { isValidApiUrl } from "../core/http";
import { probeAll, type ProbeResult } from "../core/resolver";
import { ENDPOINT_ORDER, SERVER_COLORS, type EndpointType, type Server, type ServerDraft } from "../core/types";
import { t } from "../i18n/es";
import { EndpointProbeList } from "./EndpointProbeList";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

const FORM_ID = "server-form";

interface Fields {
  name: string;
  color: string;
  urls: Record<EndpointType, string>;
  username: string;
  password: string;
}

function fieldsFrom(server?: Server): Fields {
  const url = (type: EndpointType) => server?.endpoints.find((e) => e.type === type)?.apiUrl ?? "";
  return {
    name: server?.name ?? "",
    color: server?.color ?? SERVER_COLORS[0],
    urls: { lan: url("lan"), vpn: url("vpn"), public: url("public") },
    username: server?.username ?? "",
    password: server?.password ?? "",
  };
}

function draftFrom(fields: Fields): ServerDraft {
  return {
    name: fields.name,
    color: fields.color,
    username: fields.username,
    password: fields.password,
    endpoints: ENDPOINT_ORDER.map((type) => ({ type, apiUrl: fields.urls[type] })).filter(
      (e) => e.apiUrl.trim() !== "",
    ),
  };
}

type Errors = Partial<Record<"name" | "endpoints" | EndpointType, string>>;

function validate(fields: Fields): Errors {
  const errors: Errors = {};
  if (!fields.name.trim()) errors.name = t.servers.form.nameRequired;
  const filled = ENDPOINT_ORDER.filter((type) => fields.urls[type].trim() !== "");
  if (filled.length === 0) errors.endpoints = t.servers.form.endpointRequired;
  for (const type of filled) {
    if (!isValidApiUrl(fields.urls[type])) errors[type] = t.servers.form.endpointInvalid;
  }
  return errors;
}

interface ServerFormOverlayProps {
  state: UseOverlayStateReturn;
  /** Server being edited, or undefined to create one. */
  server?: Server;
  onSave: (draft: ServerDraft) => void;
}

export function ServerFormOverlay({ state, server, onSave }: ServerFormOverlayProps) {
  // The form is mounted only while open so every open starts from fresh fields.
  return state.isOpen ? (
    <ServerFormBody key={server?.id ?? "new"} state={state} server={server} onSave={onSave} />
  ) : null;
}

function ServerFormBody({ state, server, onSave }: ServerFormOverlayProps) {
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(server));
  const [errors, setErrors] = useState<Errors>({});
  const [results, setResults] = useState<ProbeResult[] | undefined>();
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((f) => ({ ...f, [key]: value }));
    setResults(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onSave(draftFrom(fields));
    state.close();
  };

  const test = async () => {
    const found = validate(fields);
    setErrors(found);
    if (found.endpoints || ENDPOINT_ORDER.some((type) => found[type])) return;
    setTesting(true);
    setResults(await probeAll(draftFrom(fields)));
    setTesting(false);
  };

  const footer = (
    <>
      <Button variant="secondary" onPress={test} isPending={testing}>
        {t.servers.form.test}
      </Button>
      <Button variant="primary" type="submit" form={FORM_ID}>
        {t.servers.form.save}
      </Button>
    </>
  );

  return (
    <ResponsiveOverlay
      state={state}
      title={server ? t.servers.form.editTitle : t.servers.form.addTitle}
      footer={footer}
    >
      <Form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4" validationBehavior="aria">
        <TextField
          name="name"
          value={fields.name}
          onChange={(v) => set("name", v)}
          isInvalid={!!errors.name}
          autoFocus
        >
          <Label>{t.servers.form.name}</Label>
          <Input placeholder={t.servers.form.namePlaceholder} />
          <FieldError>{errors.name}</FieldError>
        </TextField>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t.servers.form.color}</legend>
          <div className="flex gap-2">
            {SERVER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                aria-pressed={fields.color === color}
                onClick={() => set("color", color)}
                className="size-7 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)] aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-[var(--foreground)]"
                style={{ background: color }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t.servers.form.endpoints}</legend>
          <p className="-mt-1 text-xs text-[var(--muted)]">{t.servers.form.endpointsHelp}</p>
          {errors.endpoints ? (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {errors.endpoints}
            </p>
          ) : null}
          {ENDPOINT_ORDER.map((type) => (
            <TextField
              key={type}
              name={`endpoint-${type}`}
              value={fields.urls[type]}
              onChange={(v) => set("urls", { ...fields.urls, [type]: v })}
              isInvalid={!!errors[type]}
            >
              <Label>{t.network[type]}</Label>
              <Input
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={
                  type === "lan" ? "192.168.1.20:9997" : type === "vpn" ? "10.8.0.2:9997" : "https://panel.ejemplo.net"
                }
              />
              <FieldError>{errors[type]}</FieldError>
            </TextField>
          ))}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField name="username" value={fields.username} onChange={(v) => set("username", v)}>
            <Label>{t.servers.form.username}</Label>
            <Input autoCapitalize="none" autoComplete="off" />
          </TextField>
          <TextField name="password" type="password" value={fields.password} onChange={(v) => set("password", v)}>
            <Label>{t.servers.form.password}</Label>
            <Input autoComplete="off" />
          </TextField>
        </div>

        {results ? (
          <div className="flex flex-col gap-2">
            <EndpointProbeList endpoints={draftFrom(fields).endpoints} results={results} />
            {results.find((r) => r.failure === "mixed-content") ? (
              <p className="text-xs text-[var(--warning)]">{t.probeFailure["mixed-content"]}</p>
            ) : null}
            {results.find((r) => r.failure === "auth") ? (
              <p className="text-xs text-[var(--warning)]">{t.probeFailure.auth}</p>
            ) : null}
          </div>
        ) : null}
      </Form>
    </ResponsiveOverlay>
  );
}

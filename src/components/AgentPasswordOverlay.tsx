import { useState, type FormEvent } from "react";
import { Button, FieldError, Form, Input, Label, TextField, type UseOverlayStateReturn } from "@heroui/react";
import { AgentError } from "../core/agent/api";
import { t } from "../i18n/es";
import { MIN_PASSWORD_LENGTH } from "./auth/AccountForm";
import { ResponsiveOverlay } from "./ResponsiveOverlay";

const FORM_ID = "agent-password-form";

interface Props {
  state: UseOverlayStateReturn;
  username: string;
  /** Changes the password on the agent; rejects with the agent's error. */
  onChange: (current: string, next: string) => Promise<void>;
}

type Errors = Partial<Record<"current" | "next" | "repeat" | "server", string>>;

export function AgentPasswordOverlay(props: Props) {
  // Mounted only while open so every open starts with empty fields.
  return props.state.isOpen ? <Body {...props} /> : null;
}

function Body({ state, username, onChange }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Errors = {};
    if (!current) found.current = t.agentAccount.currentRequired;
    if (next.length < MIN_PASSWORD_LENGTH) found.next = t.auth.passwordShort;
    else if (next === current) found.next = t.agentAccount.sameAsCurrent;
    else if (repeat !== next) found.repeat = t.auth.passwordMismatch;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      await onChange(current, next);
      state.close();
    } catch (error) {
      const status = error instanceof AgentError ? error.status : 0;
      setErrors(
        status === 401
          ? { current: t.agentAccount.wrongCurrent }
          : status === 429
            ? { server: t.servers.form.agentLimited }
            : { server: (error instanceof AgentError && error.detail) || t.agentAccount.failed },
      );
      setPending(false);
    }
  };

  return (
    <ResponsiveOverlay
      state={state}
      title={t.agentAccount.changeTitle}
      footer={
        <Button variant="primary" type="submit" form={FORM_ID} isPending={pending}>
          {t.agentAccount.save}
        </Button>
      }
    >
      <Form id={FORM_ID} onSubmit={submit} className="flex flex-col gap-4" validationBehavior="aria">
        <p className="text-sm text-[var(--muted)]">{t.agentAccount.changeBody.replace("{user}", username)}</p>
        <TextField type="password" value={current} onChange={setCurrent} isInvalid={!!errors.current} autoFocus>
          <Label>{t.auth.currentPassword}</Label>
          <Input autoComplete="current-password" />
          <FieldError>{errors.current}</FieldError>
        </TextField>
        <TextField type="password" value={next} onChange={setNext} isInvalid={!!errors.next}>
          <Label>{t.auth.newPassword}</Label>
          <Input autoComplete="new-password" />
          <FieldError>{errors.next}</FieldError>
        </TextField>
        <TextField type="password" value={repeat} onChange={setRepeat} isInvalid={!!errors.repeat}>
          <Label>{t.auth.repeat}</Label>
          <Input autoComplete="new-password" />
          <FieldError>{errors.repeat}</FieldError>
        </TextField>
        {errors.server ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {errors.server}
          </p>
        ) : null}
      </Form>
    </ResponsiveOverlay>
  );
}

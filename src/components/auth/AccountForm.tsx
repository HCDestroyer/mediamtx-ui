import { useState, type FormEvent } from "react";
import { Button, FieldError, Form, Input, Label, Meter, TextField } from "@heroui/react";
import { Eye, EyeOff } from "lucide-react";
import { passwordStrength } from "../../core/passwordStrength";
import { t } from "../../i18n/es";

export const MIN_PASSWORD_LENGTH = 8;

export interface AccountValues {
  currentPassword: string;
  username: string;
  password: string;
}

interface AccountFormProps {
  id: string;
  /** `change` also asks for the current password. */
  mode: "create" | "change";
  initialUsername?: string;
  /** Resolves with an error message to show, or null on success. */
  onSubmit: (values: AccountValues) => Promise<string | null>;
  onPendingChange?: (pending: boolean) => void;
}

const STRENGTH_COLOR = ["default", "danger", "warning", "accent", "success"] as const;

/** Username + password (+ repeat) with a strength hint. Used by first-run setup and the settings dialog. */
export function AccountForm({ id, mode, initialUsername = "", onSubmit, onPendingChange }: AccountFormProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<"current" | "username" | "password" | "repeat", string>>>({});

  const strength = passwordStrength(password);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: typeof errors = {};
    if (!username.trim()) found.username = t.auth.usernameRequired;
    if (password.length < MIN_PASSWORD_LENGTH) found.password = t.auth.passwordShort;
    else if (repeat !== password) found.repeat = t.auth.passwordMismatch;
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onPendingChange?.(true);
    const message = await onSubmit({ currentPassword, username, password });
    onPendingChange?.(false);
    if (message) setErrors({ current: message });
  };

  const type = show ? "text" : "password";
  return (
    <Form id={id} onSubmit={submit} className="flex flex-col gap-4" validationBehavior="aria">
      {mode === "change" ? (
        <TextField type="password" value={currentPassword} onChange={setCurrentPassword} isInvalid={!!errors.current} autoComplete="current-password">
          <Label>{t.auth.currentPassword}</Label>
          <Input />
          <FieldError>{errors.current}</FieldError>
        </TextField>
      ) : null}

      <TextField name="username" value={username} onChange={setUsername} isInvalid={!!errors.username} autoComplete="username" autoFocus={mode === "create"}>
        <Label>{t.auth.username}</Label>
        <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <FieldError>{errors.username}</FieldError>
      </TextField>

      <div className="flex items-end gap-2">
        <TextField className="min-w-0 flex-1" name="new-password" type={type} value={password} onChange={setPassword} isInvalid={!!errors.password} autoComplete="new-password">
          <Label>{mode === "change" ? t.auth.newPassword : t.auth.password}</Label>
          <Input />
          <FieldError>{errors.password}</FieldError>
        </TextField>
        <Button isIconOnly variant="ghost" aria-label={show ? t.auth.hide : t.auth.show} onPress={() => setShow((v) => !v)}>
          {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </Button>
      </div>

      {password ? (
        <Meter aria-label={t.auth.password} value={strength * 25} color={STRENGTH_COLOR[strength]} size="sm">
          <Meter.Track><Meter.Fill /></Meter.Track>
          <span className="text-xs text-[var(--muted)]">
            {t.auth.strength[strength]} · {t.auth.strengthHint}
          </span>
        </Meter>
      ) : null}

      <TextField name="repeat-password" type={type} value={repeat} onChange={setRepeat} isInvalid={!!errors.repeat} autoComplete="new-password">
        <Label>{t.auth.repeat}</Label>
        <Input />
        <FieldError>{errors.repeat}</FieldError>
      </TextField>
    </Form>
  );
}

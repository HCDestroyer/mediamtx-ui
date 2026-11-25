import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertDialog, Button, Card, FieldError, Form, Input, Label, TextField, useOverlayState } from "@heroui/react";
import { AlertTriangle, Eye, EyeOff, Fingerprint, Lock } from "lucide-react";
import { biometric } from "../../core/native";
import { fmt, t } from "../../i18n/es";
import { useAuth, waitSeconds } from "../../store/auth";

/** Shown while protection is on and the panel is locked. */
export default function LockScreen() {
  const savedUsername = useAuth((s) => s.username);
  const failed = useAuth((s) => s.failed);
  const unlock = useAuth((s) => s.unlock);
  const forgot = useAuth((s) => s.forgot);
  const confirm = useOverlayState();

  const [username, setUsername] = useState(savedUsername);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [wait, setWait] = useState(waitSeconds);
  const [bio] = useState(() => biometric.enabled());
  const tried = useRef(false);

  const tryBiometric = async () => {
    if (pending) return;
    const saved = await biometric.unlock(t.auth.biometricsReason);
    if (saved) await unlock(saved.username, saved.password);
  };

  // Offer the prompt as soon as the screen appears, once; the password form stays as the fallback.
  useEffect(() => {
    if (bio && !tried.current) {
      tried.current = true;
      void tryBiometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Counts the back-off down once per second.
  useEffect(() => {
    if (wait <= 0) return;
    const id = setInterval(() => setWait(waitSeconds()), 500);
    return () => clearInterval(id);
  }, [wait]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || wait > 0) return;
    setPending(true);
    const ok = await unlock(username, password);
    setPending(false);
    if (!ok) {
      setPassword("");
      setWait(waitSeconds());
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--background)] px-4 py-8 pt-safe pb-safe">
      <Card className="w-full max-w-sm">
        <Card.Content className="flex flex-col gap-5 p-1 sm:p-4">
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-[var(--accent)] text-[var(--accent-foreground)]">
              <Lock size={22} aria-hidden />
            </span>
            <h1 className="text-xl font-bold">{t.app.name}</h1>
            <p className="text-sm text-[var(--muted)]">{t.auth.lockedTitle}</p>
          </div>

          <Form onSubmit={submit} className="flex flex-col gap-4" validationBehavior="aria">
            <TextField name="username" value={username} onChange={setUsername} autoComplete="username" isInvalid={failed}>
              <Label>{t.auth.username}</Label>
              <Input autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </TextField>
            <div className="flex items-end gap-2">
              <TextField
                className="min-w-0 flex-1" name="password" type={show ? "text" : "password"} value={password}
                onChange={setPassword} autoComplete="current-password" isInvalid={failed} autoFocus={Boolean(savedUsername)}
              >
                <Label>{t.auth.password}</Label>
                <Input />
                <FieldError />
              </TextField>
              <Button isIconOnly variant="ghost" aria-label={show ? t.auth.hide : t.auth.show} onPress={() => setShow((v) => !v)}>
                {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </Button>
            </div>

            {failed ? (
              <p role="alert" className="flex items-center gap-1.5 text-sm text-[var(--danger)]">
                <AlertTriangle size={14} aria-hidden />
                {t.auth.wrong} {wait > 0 ? fmt(t.auth.retryIn, { n: wait }) : ""}
              </p>
            ) : null}

            <Button variant="primary" type="submit" fullWidth isPending={pending} isDisabled={wait > 0 || !password}>
              {pending ? t.auth.unlocking : t.auth.unlock}
            </Button>
            {bio ? (
              <Button variant="secondary" fullWidth onPress={() => void tryBiometric()}>
                <Fingerprint size={18} aria-hidden />
                {t.auth.biometricsUnlock}
              </Button>
            ) : null}
          </Form>

          <div className="flex flex-col items-center gap-2">
            <Button variant="ghost" size="sm" onPress={confirm.open}>
              {t.auth.forgot}
            </Button>
            <p className="text-center text-xs text-[var(--muted)]">{t.auth.encryptedNote}</p>
          </div>
        </Card.Content>
      </Card>

      <AlertDialog isOpen={confirm.isOpen} onOpenChange={confirm.setOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog>
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t.auth.forgotTitle}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{t.auth.forgotBody}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="tertiary" onPress={confirm.close}>{t.auth.cancel}</Button>
                <Button variant="danger" onPress={() => { confirm.close(); forgot(); }}>{t.auth.forgotConfirm}</Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </main>
  );
}
